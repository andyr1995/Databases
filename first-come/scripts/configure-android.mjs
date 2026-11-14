// Applies app.config.json and resources/android to the Android project in android/.
//
// `npx cap add android` creates a generic project and `cap sync` only refreshes the web files and
// the plugin list. Everything that makes the project THIS app is written here, so that the
// app's name, package name, version, AdMob id, icon and so on are changed in one place
// (app.config.json and resources/android) and never by hand in Android Studio:
//
//   android/app/build.gradle                  package name (namespace and applicationId), version
//                                             name and code; one line that loads release.gradle
//   android/app/release.gradle                release signing and the CI version code, both taken
//                                             from outside the repository (written whole)
//   android/app/src/main/AndroidManifest.xml  AdMob app id, portrait only, no unencrypted traffic,
//                                             marked as a game
//   android/app/src/main/java/.../MainActivity.java
//                                             the app's one screen: its package and folder, and
//                                             the call that makes the window edge to edge
//   android/app/src/main/res/values/strings.xml   the name under the icon, the package name
//   android/app/src/main/res/values/styles.xml    launch screen and dark system bars
//   android/app/src/main/res/values/colors.xml, values/ic_launcher_background.xml,
//   drawable/splash.xml, mipmap-anydpi-v26/*.xml   colours and drawings for the above (written whole)
//   android/app/src/main/res/mipmap-*/*.png   launcher icons and launch image from resources/android, if present
//   android/.gitignore                        signing keys and build leftovers stay out of git
//
// It also deletes the placeholder art that Capacitor's template brings along (its own launch
// image in eleven sizes and the stock Android launcher drawings), which would otherwise ship
// inside the app.
//
// Run it through `npm run sync` (which runs it after `cap sync android`), or alone:
//
//   node scripts/configure-android.mjs            write whatever is out of date
//   node scripts/configure-android.mjs --check    write nothing; exit 1 if something is out of date
//
// It is idempotent: a second run changes nothing. The files it edits in place (the manifest,
// build.gradle, strings.xml, styles.xml, .gitignore, and a MainActivity.java that someone has
// taken over) keep everything it does not own: other permissions, other strings, comments,
// layout. It refuses a file it does not fully understand rather than guess.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { ConfigureError, applyPlan, firstDifference, readPngInfo, xmlText } from './configure-shared.mjs';

// The layout `cap add android` creates. Relative to the folder that holds app.config.json.
const ANDROID_DIR = 'android';
const APP_GRADLE = 'android/app/build.gradle';
const RELEASE_GRADLE = 'android/app/release.gradle';
const VARIABLES_GRADLE = 'android/variables.gradle';
const GITIGNORE = 'android/.gitignore';
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const JAVA_DIR = 'android/app/src/main/java';
const RES_DIR = 'android/app/src/main/res';
const SYNCED_CONFIG = 'android/app/src/main/assets/capacitor.config.json';
const STRINGS = `${RES_DIR}/values/strings.xml`;
const STYLES = `${RES_DIR}/values/styles.xml`;
const RESOURCES_DIR = 'resources/android';

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const TOOLS_NS = 'http://schemas.android.com/tools';
const ADMOB_APP_ID_KEY = 'com.google.android.gms.ads.APPLICATION_ID';

/**
 * Icon sizes in pixels. `legacy` is the square and the round launcher icon (48 dp); `foreground`
 * is the top layer of the adaptive icon (108 dp, of which Android shows the middle 72 dp or less);
 * `launch` is the picture on the launch screen (288 dp, of which Android shows a circle 192 dp across).
 */
const DENSITIES = {
  mdpi: { legacy: 48, foreground: 108, launch: 288 },
  hdpi: { legacy: 72, foreground: 162, launch: 432 },
  xhdpi: { legacy: 96, foreground: 216, launch: 576 },
  xxhdpi: { legacy: 144, foreground: 324, launch: 864 },
  xxxhdpi: { legacy: 192, foreground: 432, launch: 1152 },
};
const ICON_FILES = {
  'ic_launcher.png': 'legacy',
  'ic_launcher_round.png': 'legacy',
  'ic_launcher_foreground.png': 'foreground',
  'ic_splash.png': 'launch',
};
/** Why a picture of this kind must have a transparent background. */
const NEEDS_TRANSPARENCY = {
  foreground:
    'It is the top layer of the adaptive icon: the emblem alone, on a transparent background, so that the background ' +
    'colour and the shape Android cuts can show around it.',
  launch: 'It is the picture on the launch screen: the emblem alone, on a transparent background, so that the launch colour shows around it.',
};

/**
 * Placeholder art from Capacitor's template that this script deletes. The eleven splash.png files
 * are Capacitor's own launch image; drawable/splash.xml (written below) takes their place under
 * the same resource name. The two launcher drawings are Android Studio's stock robot and grid,
 * which the adaptive icon does not use.
 */
const TEMPLATE_ART = [
  'drawable/splash.png',
  ...['land', 'port'].flatMap((way) => Object.keys(DENSITIES).map((density) => `drawable-${way}-${density}/splash.png`)),
  'drawable/ic_launcher_background.xml',
  'drawable-v24/ic_launcher_foreground.xml',
];

/**
 * The lowest target API level Google Play accepts for new apps and updates: Android 16 (API
 * level 36) since 31 August 2026, as read on 14 November 2026 at
 * https://support.google.com/googleplay/android-developer/answer/11926878. Google raises it by
 * one every August; the target itself comes from Capacitor (android/variables.gradle), so the
 * cure for a warning about it is a newer Capacitor, and after that a newer number here.
 */
const PLAY_TARGET_API = { level: 36, since: '31 August 2026', read: '14 November 2026' };

// ---------------------------------------------------------------------------------------------
// app.config.json and resources/android/colors.json

const JAVA_KEYWORDS = new Set(
  (
    'abstract assert boolean break byte case catch char class const continue default do double else enum extends ' +
    'false final finally float for goto if implements import instanceof int interface long native new null package ' +
    'private protected public return short static strictfp super switch synchronized this throw throws transient ' +
    'true try void volatile while'
  ).split(' '),
);

/** True for a name Android accepts as a package name and Java accepts as the package of the app's code. */
function isAndroidPackageName(value) {
  if (typeof value !== 'string') return false;
  const segments = value.split('.');
  return segments.length >= 2 && segments.every((segment) => /^[A-Za-z][A-Za-z0-9_]*$/.test(segment) && !JAVA_KEYWORDS.has(segment));
}

/**
 * The Android package name: "androidAppId" if app.config.json has one, else "appId", which is
 * then the same id as the iPhone bundle id. The second field exists because the two stores
 * do not accept the same characters (Apple allows hyphens and no underscores, Android the
 * reverse), so an id that is already registered with Apple may be one Android cannot take.
 */
export function androidPackageName(config) {
  return config.androidAppId ?? config.appId;
}

const PACKAGE_NAME_RULES =
  'at least two parts separated by dots, each starting with a letter, no hyphens, and no Java keyword (such as "new" or ' +
  '"public") as a part';

function readAppConfig(root) {
  const file = path.join(root, 'app.config.json');
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigureError(`Cannot read app.config.json: ${error.message}`);
  }
  const problems = [];
  const need = (ok, message) => {
    if (!ok) problems.push(message);
  };
  const isText = (value) => typeof value === 'string' && value.trim().length > 0;

  // Android is stricter than iOS here: the name is also the Java package of the app's code.
  if (config.androidAppId !== undefined) {
    need(
      isAndroidPackageName(config.androidAppId),
      `"androidAppId" must be an Android package name such as com.yourname.firstcome: ${PACKAGE_NAME_RULES}. ` +
        'Leave the field out to use "appId" on Android as well',
    );
  } else {
    // What the id would be with the two usual repairs, offered only if that gives a valid name.
    const repaired = isText(config.appId)
      ? config.appId
          .split('.')
          .map((segment) => (JAVA_KEYWORDS.has(segment) ? `${segment}_` : segment.replace(/-/g, '_')))
          .join('.')
      : '';
    need(
      isAndroidPackageName(config.appId),
      `"appId" must be an Android package name such as com.yourname.firstcome: ${PACKAGE_NAME_RULES}. Either use only ` +
        'letters, digits and dots, so that the one id works on iPhone and on Android, or keep "appId" for iPhone and give ' +
        'Android a name of its own in a second field' +
        (isAndroidPackageName(repaired) ? `, for example "androidAppId": ${JSON.stringify(repaired)}` : ', "androidAppId"'),
    );
  }
  need(
    isText(config.appName) && config.appName === config.appName.trim() && !/[\u0000-\u001f\u007f]|\s{2}/.test(config.appName),
    '"appName" must be the name shown under the icon: one line, without spaces at either end or two spaces in a row',
  );
  need(
    isText(config.version) && /^\d+(\.\d+){0,2}$/.test(config.version),
    '"version" must be one to three numbers separated by dots, such as 1.0.0',
  );
  need(
    Number.isInteger(config.build) && config.build >= 1 && config.build <= 2100000000,
    '"build" must be a whole number from 1 to 2100000000 (the largest version code Google Play accepts)',
  );
  need(
    isText(config.admob?.android?.appId) && /^ca-app-pub-\d{16}~\d{10}$/.test(config.admob.android.appId),
    '"admob.android.appId" must be an AdMob app id: ca-app-pub-XXXXXXXXXXXXXXXX~YYYYYYYYYY (with a ~, not a /)',
  );
  if (problems.length > 0) {
    throw new ConfigureError(`app.config.json needs fixing:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}

function readColours(root) {
  const file = path.join(root, RESOURCES_DIR, 'colors.json');
  let colours;
  try {
    colours = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigureError(`Cannot read ${RESOURCES_DIR}/colors.json (${error.message}). Run: npm run art`);
  }
  for (const name of ['iconBackground', 'splashBackground', 'statusBar']) {
    if (typeof colours?.[name] !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(colours[name])) {
      throw new ConfigureError(`${RESOURCES_DIR}/colors.json: "${name}" must be a colour written as #RRGGBB.`);
    }
  }
  return colours;
}

// ---------------------------------------------------------------------------------------------
// XML, edited in place.
//
// AndroidManifest.xml, strings.xml and styles.xml are not regenerated: Capacitor creates them,
// plugins' instructions and people add to them. They are read into a tree in which every element
// and attribute remembers where it sits in the text. A change then replaces or inserts exactly
// those characters, so every other byte, comment and blank line stays as it was. A file this
// reader does not fully understand is refused, and every result is parsed again by a real XML
// parser (@xmldom/xmldom) and checked for the wanted values before it is accepted.

const XML_NAME = '[^\\s<>/=!?&"\']+';

function attributeOf(element, name) {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

function childrenNamed(element, name) {
  return element.children.filter((child) => child.name === name);
}

class XmlFile {
  /** @param {string} text @param {string} label The file's path, for error messages. */
  constructor(text, label) {
    this.text = text;
    this.label = label;
    this.eol = text.includes('\r\n') ? '\r\n' : '\n';
    this.root = this.#read();
  }

  fail(message, at) {
    const where = at === undefined ? '' : ` (line ${this.text.slice(0, at).split('\n').length})`;
    throw new ConfigureError(`${this.label}: ${message}${where}. It was not touched.`);
  }

  #decode(raw, at) {
    if (/&(?!(?:#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);)/.test(raw)) this.fail('has an & that does not start an entity', at);
    return raw.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (whole, body) => {
      if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body];
      if (named === undefined) this.fail(`uses the entity ${whole}, which this script does not know`, at);
      return named;
    });
  }

  /** Reads the whole text. Offsets are positions in `this.text`. */
  #read() {
    const text = this.text;
    const openTag = new RegExp(`<(${XML_NAME})`, 'y');
    const attribute = new RegExp(`(\\s+)(${XML_NAME})\\s*=\\s*(?:"([^<"]*)"|'([^<']*)')`, 'y');
    const tagEnd = /\s*(\/?)>/y;
    const closeTag = new RegExp(`</(${XML_NAME})\\s*>`, 'y');
    const document = { name: null, children: [], parent: null };
    let current = document;
    let i = 0;
    const skipTo = (terminator, what) => {
      const end = text.indexOf(terminator, i);
      if (end === -1) this.fail(`has ${what} that is never closed`, i);
      i = end + terminator.length;
    };
    while (i < text.length) {
      if (text[i] !== '<') {
        const next = text.indexOf('<', i);
        const end = next === -1 ? text.length : next;
        if (current === document && text.slice(i, end).trim() !== '') this.fail('has text outside the root element', i);
        i = end;
      } else if (text.startsWith('<!--', i)) {
        skipTo('-->', 'a comment');
      } else if (text.startsWith('<?', i)) {
        skipTo('?>', 'a processing instruction');
      } else if (text.startsWith('<![CDATA[', i)) {
        skipTo(']]>', 'a CDATA section');
      } else if (text.startsWith('<!', i)) {
        this.fail('has a DOCTYPE or another declaration this script does not read', i);
      } else if (text.startsWith('</', i)) {
        closeTag.lastIndex = i;
        const match = closeTag.exec(text);
        if (!match || current === document || match[1] !== current.name) this.fail('has a closing tag that closes nothing', i);
        current.closeStart = i;
        current.end = i + match[0].length;
        current = current.parent;
        i += match[0].length;
      } else {
        openTag.lastIndex = i;
        const open = openTag.exec(text);
        if (!open) this.fail('has a < that does not start a tag', i);
        const element = { name: open[1], start: i, nameEnd: i + open[0].length, attrs: [], children: [], parent: current };
        i = element.nameEnd;
        for (;;) {
          attribute.lastIndex = i;
          const match = attribute.exec(text);
          if (!match) break;
          const quoted = match[3] !== undefined ? match[3] : match[4];
          const end = i + match[0].length;
          if (element.attrs.some((other) => other.name === match[2])) this.fail(`sets ${match[2]} twice on <${element.name}>`, i);
          element.attrs.push({
            name: match[2],
            value: this.#decode(quoted, i),
            quote: match[3] !== undefined ? '"' : "'",
            start: i, // of the white space in front of the name
            nameStart: i + match[1].length,
            valueStart: end - 1 - quoted.length,
            valueEnd: end - 1,
            end,
          });
          i = end;
        }
        tagEnd.lastIndex = i;
        const close = tagEnd.exec(text);
        if (!close) this.fail(`has a <${element.name}> tag this script cannot read`, element.start);
        i += close[0].length;
        element.openEnd = i;
        element.selfClosing = close[1] === '/';
        if (current === document && document.children.length > 0) this.fail('has more than one root element', element.start);
        current.children.push(element);
        if (element.selfClosing) element.end = i;
        else current = element;
      }
    }
    if (current !== document) this.fail(`has a <${current.name}> that is never closed`, current.start);
    if (document.children.length !== 1) this.fail('has no root element');
    return document.children[0];
  }

  #splice(start, end, insert) {
    this.text = this.text.slice(0, start) + insert + this.text.slice(end);
    this.root = this.#read();
  }

  /** White space at the start of the line that `offset` is on. */
  #indentAt(offset) {
    return /^[ \t]*/.exec(this.text.slice(this.text.lastIndexOf('\n', offset - 1) + 1, offset))[0];
  }

  /** The decoded text between an element's tags. */
  content(element) {
    return element.selfClosing ? '' : this.#decode(this.text.slice(element.openEnd, element.closeStart), element.openEnd);
  }

  /**
   * The children of `parent` called `tag` whose attribute `key` is `value`. More than `most` of
   * them is an error: the file is then not one this script can safely edit.
   */
  find(parent, tag, key, value, most = 1) {
    const found = childrenNamed(parent, tag).filter((child) => attributeOf(child, key) === value);
    if (found.length > most) this.fail(`has ${found.length} <${tag} ${key}="${value}"> elements where at most ${most} is expected`, found[most].start);
    return found;
  }

  /**
   * Sets an attribute. An existing one keeps its place and its quotes. A new one is written the
   * way the element's other attributes are: on a line of its own if they are, else on the same line.
   */
  setAttribute(element, name, value) {
    const existing = element.attrs.find((attribute) => attribute.name === name);
    const escape = (quote) => xmlText(value).replaceAll(quote, quote === '"' ? '&quot;' : '&apos;');
    if (existing) {
      if (existing.value !== value) this.#splice(existing.valueStart, existing.valueEnd, escape(existing.quote));
      return;
    }
    const last = element.attrs.at(-1);
    const lead = last ? this.text.slice(last.start, last.nameStart) : ' ';
    this.#splice(last ? last.end : element.nameEnd, last ? last.end : element.nameEnd, `${/[\r\n]/.test(lead) ? lead : ' '}${name}="${escape('"')}"`);
  }

  /** Replaces everything between an element's tags with `value` as text. */
  setContent(element, value) {
    if (element.selfClosing) this.fail(`has a <${element.name}/> without a closing tag where a value belongs`, element.start);
    if (element.children.length === 0 && this.content(element) === value) return;
    this.#splice(element.openEnd, element.closeStart, xmlText(value));
  }

  /** Adds lines as the last thing inside `parent`, indented like its other children. */
  append(parent, lines, { blankLineBefore = false } = {}) {
    if (parent.selfClosing) this.fail(`has a <${parent.name}/> without a closing tag, so nothing can be added to it`, parent.start);
    const tail = /\s*$/.exec(this.text.slice(parent.openEnd, parent.closeStart))[0];
    const at = parent.closeStart - tail.length;
    const parentIndent = this.#indentAt(parent.start);
    const first = parent.children[0];
    const childIndent = first && /[\r\n]/.test(this.text.slice(parent.openEnd, first.start)) ? this.#indentAt(first.start) : `${parentIndent}    `;
    const block = lines.map((line) => childIndent + line).join(this.eol);
    const lead = blankLineBefore && at > parent.openEnd ? this.eol + this.eol : this.eol;
    // A closing tag that shared a line with the last child gets a line of its own.
    this.#splice(at, at, lead + block + (/[\r\n]/.test(tail) ? '' : this.eol + parentIndent));
  }

  /** Removes an element together with the line break and indentation in front of it. */
  remove(element) {
    const lead = /(?:\r?\n)?[ \t]*$/.exec(this.text.slice(0, element.start))[0];
    this.#splice(element.start - lead.length, element.end, '');
  }
}

/** Parses with a real XML parser. Any complaint from it, however small, is an error here. */
function parseStrict(text, label) {
  try {
    return new DOMParser({
      onError: (level, message) => {
        throw new Error(`${level}: ${message}`);
      },
    }).parseFromString(text, 'text/xml');
  } catch (error) {
    throw new ConfigureError(`Internal error: the ${label} this script produced is not valid XML (${String(error.message).split('\n')[0]}). Nothing was written.`);
  }
}

function domChildren(node, tag) {
  return Array.from(node.childNodes).filter((child) => child.nodeType === 1 && child.nodeName === tag);
}

/** Throws unless `actual` is `wanted`: the last line of defence before a file is written. */
function proved(label, what, actual, wanted) {
  if (actual !== wanted) {
    throw new ConfigureError(
      `Internal error: in the ${label} this script produced, ${what} is ${JSON.stringify(actual)}, not ${JSON.stringify(wanted)}. Nothing was written.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// AndroidManifest.xml

/** What this script sets on <application> and on the game's activity, and why. */
const APPLICATION_ATTRIBUTES = {
  // The game talks to nothing over plain http; neither do the advert and billing libraries.
  // This is already the default for an app that targets a current Android; saying so keeps it
  // true whatever a library's manifest asks for.
  'android:usesCleartextTraffic': 'false',
  // On tablets and unfolded phones, Android 16 ignores an app's portrait lock unless the app is
  // a game (developer.android.com/about/versions/16/behavior-changes-16, read 14 November 2026).
  // It also files the app under Games in the launcher's and the system's own lists.
  'android:appCategory': 'game',
};
const ACTIVITY_ATTRIBUTES = {
  // The game is laid out for an upright phone only.
  'android:screenOrientation': 'portrait',
};

function buildManifest(existing, config) {
  const xml = new XmlFile(existing, MANIFEST);
  if (xml.root.name !== 'manifest' || attributeOf(xml.root, 'xmlns:android') !== ANDROID_NS) {
    xml.fail('is not an Android manifest with the usual xmlns:android declaration');
  }
  const application = () => {
    const found = childrenNamed(xml.root, 'application');
    if (found.length !== 1) xml.fail('does not have exactly one <application>');
    return found[0];
  };
  const mainActivity = () => {
    const found = childrenNamed(application(), 'activity').filter((activity) => /(^|\.)MainActivity$/.test(attributeOf(activity, 'android:name') ?? ''));
    if (found.length !== 1) xml.fail('does not have exactly one <activity android:name=".MainActivity">, the screen Capacitor creates');
    return found[0];
  };

  for (const [name, value] of Object.entries(APPLICATION_ATTRIBUTES)) xml.setAttribute(application(), name, value);
  for (const [name, value] of Object.entries(ACTIVITY_ATTRIBUTES)) xml.setAttribute(mainActivity(), name, value);

  const [adMob] = xml.find(application(), 'meta-data', 'android:name', ADMOB_APP_ID_KEY);
  if (adMob) {
    xml.setAttribute(adMob, 'android:value', config.admob.android.appId);
  } else {
    xml.append(
      application(),
      [
        '<!-- AdMob app id, from app.config.json. Google\'s advert library stops the app at launch without it. -->',
        '<meta-data',
        `    android:name="${ADMOB_APP_ID_KEY}"`,
        `    android:value="${xmlText(config.admob.android.appId)}" />`,
      ],
      { blankLineBefore: true },
    );
  }

  // Prove the result with an independent parser.
  const dom = parseStrict(xml.text, 'AndroidManifest.xml');
  const [domApplication] = domChildren(dom.documentElement, 'application');
  for (const [name, value] of Object.entries(APPLICATION_ATTRIBUTES)) {
    proved('AndroidManifest.xml', name, domApplication.getAttributeNS(ANDROID_NS, name.replace('android:', '')), value);
  }
  const domActivity = domChildren(domApplication, 'activity').filter((a) => /(^|\.)MainActivity$/.test(a.getAttributeNS(ANDROID_NS, 'name')));
  proved('AndroidManifest.xml', 'the number of MainActivity entries', domActivity.length, 1);
  for (const [name, value] of Object.entries(ACTIVITY_ATTRIBUTES)) {
    proved('AndroidManifest.xml', name, domActivity[0].getAttributeNS(ANDROID_NS, name.replace('android:', '')), value);
  }
  const domAdMob = domChildren(domApplication, 'meta-data').filter((m) => m.getAttributeNS(ANDROID_NS, 'name') === ADMOB_APP_ID_KEY);
  proved('AndroidManifest.xml', 'the number of AdMob app id entries', domAdMob.length, 1);
  proved('AndroidManifest.xml', 'the AdMob app id', domAdMob[0].getAttributeNS(ANDROID_NS, 'value'), config.admob.android.appId);
  return xml.text;
}

// ---------------------------------------------------------------------------------------------
// res/values/strings.xml

/**
 * A value the way a <string> resource wants it. Android reads backslash, both quotes and a
 * leading @ or ? specially; they are escaped so that the text is shown exactly as given.
 * (XML's own escaping of & and < is added when the value is written into the file.)
 */
export function androidString(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/^([@?])/, '\\$1');
}

function wantedStrings(config) {
  return {
    app_name: config.appName, // under the icon, and in the system's list of apps
    title_activity_main: config.appName, // in the list of recent apps
    package_name: androidPackageName(config),
    custom_url_scheme: androidPackageName(config),
  };
}

function buildStrings(existing, config) {
  const xml = new XmlFile(existing, STRINGS);
  if (xml.root.name !== 'resources') xml.fail('is not a <resources> file');
  const wanted = wantedStrings(config);
  for (const [name, value] of Object.entries(wanted)) {
    const [string] = xml.find(xml.root, 'string', 'name', name);
    if (string) xml.setContent(string, androidString(value));
    else xml.append(xml.root, [`<string name="${name}">${xmlText(androidString(value))}</string>`]);
  }

  const dom = parseStrict(xml.text, 'strings.xml');
  for (const [name, value] of Object.entries(wanted)) {
    const found = domChildren(dom.documentElement, 'string').filter((s) => s.getAttribute('name') === name);
    proved('strings.xml', `the number of "${name}" strings`, found.length, 1);
    proved('strings.xml', `the string "${name}"`, found[0].textContent, androidString(value));
  }
  return xml.text;
}

// ---------------------------------------------------------------------------------------------
// res/values/styles.xml: the launch screen and the system bars.
//
// The launch screen. The SplashScreen plugin shows it through Android's own splash screen
// (androidx.core.splashscreen, the same on every Android version the app runs on): a plain
// background with one picture in the middle. It needs the activity's theme to descend from
// Theme.SplashScreen and to name the theme to switch to afterwards; the two colours and the
// picture are what this script supplies. How long the screen stays is not decided here but in
// capacitor.config.ts (SplashScreen.launchAutoHide and launchShowDuration) and by the game
// calling platform.appReady().
//
// The picture is ic_splash.png: the emblem of the launcher icon, drawn at the size of the launch
// screen so that it is sharp. Android draws it on a 288 dp square and shows the middle two
// thirds, a circle 192 dp across, which the emblem fits inside.
//
// The system bars (clock and battery at the top, Back and Home at the bottom). The game is
// dark, so both bars carry light symbols on something dark, during launch and afterwards. The
// themes say so for the time before the app's own code runs. Once it runs, MainActivity makes
// the window edge to edge with transparent bars (see MainActivity.java below; on Android 15 and
// later the system does that by itself), and Capacitor's SystemBars plugin sets the colour of
// the symbols from capacitor.config.ts (SystemBars.style, which must be 'DARK': this script
// warns if it is not). What is seen behind the bars is then one of two things. With a current
// WebView (140 or later) the web view reaches under them: it is the game itself. With an older
// one Capacitor keeps the web view clear of the bars: it is the window's background, set here.
// The two bar colours in the theme are overridden by then; they stay as what an Android
// version that draws the window before the code runs would show.

const STYLE_ITEMS = {
  'AppTheme.NoActionBar': [
    // What shows behind the (transparent) system bars where the web view does not reach under
    // them. (The web view has a background colour of its own, from capacitor.config.ts.)
    { name: 'android:windowBackground', value: '@color/system_bar' },
    { name: 'android:statusBarColor', value: '@color/system_bar' },
    { name: 'android:navigationBarColor', value: '@color/system_bar' },
    { name: 'android:windowLightStatusBar', value: 'false' },
    { name: 'android:windowLightNavigationBar', value: 'false', targetApi: '27' },
  ],
  'AppTheme.NoActionBarLaunch': [
    { name: 'windowSplashScreenBackground', value: '@color/splash_background' },
    { name: 'windowSplashScreenAnimatedIcon', value: '@mipmap/ic_splash' },
    { name: 'postSplashScreenTheme', value: '@style/AppTheme.NoActionBar' },
    { name: 'android:windowLightStatusBar', value: 'false' },
    { name: 'android:windowLightNavigationBar', value: 'false', targetApi: '27' },
  ],
};
/** Wanted `parent` of a style; a style not listed keeps the parent it has. */
const STYLE_PARENTS = { 'AppTheme.NoActionBarLaunch': 'Theme.SplashScreen' };
/**
 * Items this script takes out. The template paints its launch image over the whole launch
 * window with android:background; the splash screen described above replaces that.
 */
const STYLE_ITEMS_REMOVED = { 'AppTheme.NoActionBarLaunch': ['android:background'] };

function buildStyles(existing) {
  const xml = new XmlFile(existing, STYLES);
  if (xml.root.name !== 'resources') xml.fail('is not a <resources> file');
  const style = (styleName) => {
    const [found] = xml.find(xml.root, 'style', 'name', styleName);
    if (!found) xml.fail(`has no <style name="${styleName}">, which Capacitor's project uses for the game's screen`);
    return found;
  };

  // tools:targetApi tells Android's lint that an item is meant for newer Android versions only
  // (older ones skip an item they do not know).
  xml.setAttribute(xml.root, 'xmlns:tools', TOOLS_NS);
  for (const [styleName, items] of Object.entries(STYLE_ITEMS)) {
    if (STYLE_PARENTS[styleName]) xml.setAttribute(style(styleName), 'parent', STYLE_PARENTS[styleName]);
    for (const unwanted of STYLE_ITEMS_REMOVED[styleName] ?? []) {
      for (;;) {
        const [found] = xml.find(style(styleName), 'item', 'name', unwanted, Infinity);
        if (!found) break;
        xml.remove(found);
      }
    }
    for (const item of items) {
      const [existingItem] = xml.find(style(styleName), 'item', 'name', item.name);
      if (!existingItem) {
        const targetApi = item.targetApi ? ` tools:targetApi="${item.targetApi}"` : '';
        xml.append(style(styleName), [`<item name="${item.name}"${targetApi}>${xmlText(item.value)}</item>`]);
        continue;
      }
      xml.setContent(existingItem, item.value);
      if (item.targetApi) xml.setAttribute(xml.find(style(styleName), 'item', 'name', item.name)[0], 'tools:targetApi', item.targetApi);
    }
  }

  const dom = parseStrict(xml.text, 'styles.xml');
  for (const [styleName, items] of Object.entries(STYLE_ITEMS)) {
    const found = domChildren(dom.documentElement, 'style').filter((s) => s.getAttribute('name') === styleName);
    proved('styles.xml', `the number of "${styleName}" styles`, found.length, 1);
    if (STYLE_PARENTS[styleName]) proved('styles.xml', `the parent of ${styleName}`, found[0].getAttribute('parent'), STYLE_PARENTS[styleName]);
    const domItems = domChildren(found[0], 'item');
    for (const item of items) {
      const matching = domItems.filter((i) => i.getAttribute('name') === item.name);
      proved('styles.xml', `the number of ${item.name} items in ${styleName}`, matching.length, 1);
      proved('styles.xml', `${item.name} in ${styleName}`, matching[0].textContent, item.value);
      if (item.targetApi) proved('styles.xml', `tools:targetApi of ${item.name}`, matching[0].getAttributeNS(TOOLS_NS, 'targetApi'), item.targetApi);
    }
    for (const unwanted of STYLE_ITEMS_REMOVED[styleName] ?? []) {
      proved('styles.xml', `the number of ${unwanted} items in ${styleName}`, domItems.filter((i) => i.getAttribute('name') === unwanted).length, 0);
    }
  }
  return xml.text;
}

// ---------------------------------------------------------------------------------------------
// Small resource files this script writes whole.

const WRITTEN_BY = 'Written by scripts/configure-android.mjs. Do not edit: `npm run sync` writes it again.';

function coloursXml(colours) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${WRITTEN_BY} The colours come from ${RESOURCES_DIR}/colors.json. -->
<resources>
    <!-- The launch screen. -->
    <color name="splash_background">${colours.splashBackground}</color>
    <!-- Behind the status bar and the navigation bar, where the game itself is not drawn under them. -->
    <color name="system_bar">${colours.statusBar}</color>
</resources>
`;
}

function launcherBackgroundXml(colours) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${WRITTEN_BY} The colour comes from ${RESOURCES_DIR}/colors.json. -->
<resources>
    <!-- Behind the emblem in the launcher icon (the adaptive icon's background layer). -->
    <color name="ic_launcher_background">${colours.iconBackground}</color>
</resources>
`;
}

/** The launcher icon for Android 8 and later: Android cuts the shape, these are the two layers. */
const ADAPTIVE_ICON_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- ${WRITTEN_BY} -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;

/**
 * The launch screen as one drawing, under the name the SplashScreen plugin looks up ("splash")
 * when it is asked to show the splash screen again later, or when Android's own splash screen
 * cannot be used. It is the same picture as the launch screen proper: background colour,
 * emblem in the middle. Nothing in the game asks for it today.
 */
const SPLASH_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- ${WRITTEN_BY} -->
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/splash_background" />
    <item
        android:width="288dp"
        android:height="288dp"
        android:drawable="@mipmap/ic_splash"
        android:gravity="center" />
</layer-list>
`;

function planResources(root, colours, plan, remove, notes) {
  const res = path.join(root, RES_DIR);
  plan.set(path.join(res, 'values', 'colors.xml'), coloursXml(colours));
  plan.set(path.join(res, 'values', 'ic_launcher_background.xml'), launcherBackgroundXml(colours));
  plan.set(path.join(res, 'drawable', 'splash.xml'), SPLASH_XML);
  plan.set(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), ADAPTIVE_ICON_XML);
  plan.set(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), ADAPTIVE_ICON_XML);
  for (const file of TEMPLATE_ART) remove.push(path.join(res, ...file.split('/')));

  // Launcher icons and the launch image: twenty PNG files, four for each of five screen densities.
  const wanted = Object.entries(DENSITIES).flatMap(([density, sizes]) =>
    Object.entries(ICON_FILES).map(([file, kind]) => ({ relative: `mipmap-${density}/${file}`, size: sizes[kind], kind })),
  );
  const present = wanted.filter((icon) => existsSync(path.join(root, RESOURCES_DIR, ...icon.relative.split('/'))));
  if (present.length === 0) {
    notes.push(`${RESOURCES_DIR}/mipmap-*/ not found: the launcher icons already in the project are kept. Run: npm run art`);
    return;
  }
  if (present.length < wanted.length) {
    const missing = wanted.filter((icon) => !present.includes(icon)).map((icon) => icon.relative);
    throw new ConfigureError(`${RESOURCES_DIR} has only some of the launcher icons. Missing: ${missing.join(', ')}. Run: npm run art`);
  }
  for (const icon of wanted) {
    const label = `${RESOURCES_DIR}/${icon.relative}`;
    const png = readFileSync(path.join(root, RESOURCES_DIR, ...icon.relative.split('/')));
    const info = readPngInfo(png, label);
    if (info.width !== icon.size || info.height !== icon.size) {
      throw new ConfigureError(`${label} is ${info.width} x ${info.height}; it must be ${icon.size} x ${icon.size}.`);
    }
    if (NEEDS_TRANSPARENCY[icon.kind] && !info.transparency) {
      throw new ConfigureError(`${label} has no transparency. ${NEEDS_TRANSPARENCY[icon.kind]}`);
    }
    plan.set(path.join(res, ...icon.relative.split('/')), png);
  }
}

// ---------------------------------------------------------------------------------------------
// MainActivity.java: the one screen of the app, which hosts the web view.
//
// Two things about it are this script's business.
//
// Its package is the app's package name, and Java wants the file in the folder that matches the
// package. So when the package name changes, the package line is rewritten and the file moves.
//
// And it makes the window edge to edge on every Android version. An app that targets Android 15
// or later is drawn under the status bar and the navigation bar on Android 15 and later whatever
// it does; on Android 14 and earlier it is not, unless the app asks. Capacitor's SystemBars
// plugin tells the page how tall the bars are either way (--safe-area-inset-* in CSS), and
// with a current WebView (140 or later) it expects the page to be under them. On Android 14
// and earlier the page would then keep clear of bars it is not under, and the bridge would add
// the navigation bar's height to the advert banner's: an empty strip above the banner.
// Capacitor's documentation for SystemBars says to call EdgeToEdge.enable in the activity for
// this reason, and that Capacitor 9 will do it itself (read on 14 November 2026). When that
// day comes the call below is harmless, and can go.
//
// The bars are made transparent with light symbols, whatever the phone's theme: without the
// two arguments EdgeToEdge follows the phone's light or dark theme, and the game is always dark.
//
// The call comes straight after super.onCreate, which is where Android's own guide puts it
// (developer.android.com/develop/ui/views/layout/edge-to-edge, read on 14 November 2026).
// Capacitor's BridgeActivity switches from the launch theme to the app's theme inside its
// onCreate, just before it creates the window's content; a call made before super.onCreate
// would have the window's frame built under the launch theme instead. Nothing is laid out or
// drawn until onCreate has returned, so the later call costs nothing that can be seen.
//
// The file Capacitor creates is an empty class. The script replaces it with the file below and
// from then on writes that file whole (its first line says so). Someone who needs code of their
// own in MainActivity deletes that first comment: the script then keeps the file as it finds
// it, changes only the package line, and refuses to go on if the EdgeToEdge call has gone.

const MAIN_ACTIVITY_MARKER = `// ${WRITTEN_BY}`;
const EDGE_TO_EDGE_CALL = 'EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));';

function mainActivitySource(packageName) {
  return `${MAIN_ACTIVITY_MARKER}
// To add code of your own, delete these three comment lines. The script then keeps the file as
// you leave it, changes only its package line, and checks that the EdgeToEdge call is still there.
package ${packageName};

import android.graphics.Color;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Draw the game under the status bar and the navigation bar on every Android version.
        // Android 15 and later do so anyway; this makes Android 14 and earlier the same, which
        // Capacitor's SystemBars plugin and the advert banner's position rely on. Both bars are
        // transparent with light symbols, because the game is dark whatever the phone's theme.
        ${EDGE_TO_EDGE_CALL}
    }
}
`;
}

/** Java source without its comments, for looking at the code alone. (String literals are not treated specially.) */
function withoutJavaComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
}

function planMainActivity(root, config, plan, remove) {
  const javaDir = path.join(root, JAVA_DIR);
  const packageName = androidPackageName(config);
  const found = [];
  const walk = (dir) => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === 'MainActivity.java') found.push(full);
    }
  };
  walk(javaDir);
  if (found.length !== 1) {
    throw new ConfigureError(`${JAVA_DIR} has ${found.length} files called MainActivity.java; this script expects the one that \`npx cap add android\` creates.`);
  }
  const relative = path.relative(root, found[0]).split(path.sep).join('/');
  const source = readFileSync(found[0], 'utf8');
  const packageLines = [...source.matchAll(/^([ \t]*package[ \t]+)[\w.]+([ \t]*;)/gm)];
  if (packageLines.length !== 1 || !/\bclass\s+MainActivity\s+extends\s+BridgeActivity\b/.test(source)) {
    throw new ConfigureError(
      `${relative} is not the MainActivity that Capacitor creates (one package line, and a class MainActivity that extends BridgeActivity). It was not touched.`,
    );
  }

  const code = withoutJavaComments(source);
  const untouchedTemplate = /^\s*package\s+[\w.]+\s*;\s*import\s+com\.getcapacitor\.BridgeActivity\s*;\s*public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{\s*\}\s*$/.test(code);
  let wantedSource;
  if (untouchedTemplate || source.includes(MAIN_ACTIVITY_MARKER)) {
    wantedSource = mainActivitySource(packageName);
  } else {
    // Someone's own MainActivity: theirs to keep, as long as the window is still made edge to edge.
    if (!/\bEdgeToEdge\s*\.\s*enable\s*\(/.test(code)) {
      throw new ConfigureError(
        `${relative} has been changed by hand and no longer makes the window edge to edge, which the advert banner's ` +
          'position depends on on Android 14 and earlier. In its onCreate, straight after super.onCreate(savedInstanceState), add\n' +
          `    ${EDGE_TO_EDGE_CALL}\n` +
          'with the imports android.graphics.Color, androidx.activity.EdgeToEdge and androidx.activity.SystemBarStyle. ' +
          'It was not touched.',
      );
    }
    const [line] = packageLines;
    wantedSource = source.slice(0, line.index) + line[1] + packageName + line[2] + source.slice(line.index + line[0].length);
  }
  const wanted = path.join(javaDir, ...packageName.split('.'), 'MainActivity.java');
  plan.set(wanted, wantedSource);
  if (found[0] !== wanted) remove.push(found[0]);
}

// ---------------------------------------------------------------------------------------------
// android/app/build.gradle (edited in place) and android/app/release.gradle (written whole).
//
// A Gradle file is a program, and there is no parser for it here. So the script changes only
// whole lines of a shape it knows, each of which must occur exactly once; anything else means
// the file is not the one Capacitor creates, and it is left alone.

const GRADLE_LINES = [
  { what: 'namespace', pattern: /^([ \t]*namespace[ \t]*=?[ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*')[ \t]*(?=\r?$)/gm, value: (config) => JSON.stringify(androidPackageName(config)) },
  { what: 'applicationId', pattern: /^([ \t]*applicationId[ \t]*=?[ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*')[ \t]*(?=\r?$)/gm, value: (config) => JSON.stringify(androidPackageName(config)) },
  { what: 'versionCode', pattern: /^([ \t]*versionCode[ \t]*=?[ \t]*)\d+[ \t]*(?=\r?$)/gm, value: (config) => String(config.build) },
  { what: 'versionName', pattern: /^([ \t]*versionName[ \t]*=?[ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*')[ \t]*(?=\r?$)/gm, value: (config) => JSON.stringify(config.version) },
];
const APPLY_CAPACITOR = /^[ \t]*apply from:[ \t]*['"]capacitor\.build\.gradle['"][ \t]*(?=\r?$)/gm;
const APPLY_RELEASE = /^[ \t]*apply from:[ \t]*['"]release\.gradle['"][ \t]*(?=\r?$)/gm;
const APPLY_RELEASE_LINES = [
  '// Release signing and the version code a CI run passes in: see release.gradle (scripts/configure-android.mjs).',
  "apply from: 'release.gradle'",
];

function editAppGradle(existing, config) {
  let text = existing;
  const notCapacitors = (problem) =>
    new ConfigureError(`${APP_GRADLE}: ${problem}. This script expects the build file that \`npx cap add android\` creates. It was not touched.`);
  for (const line of GRADLE_LINES) {
    const matches = [...text.matchAll(line.pattern)];
    if (matches.length !== 1) throw notCapacitors(`expected exactly one "${line.what}" line and found ${matches.length}`);
    const [match] = matches;
    text = text.slice(0, match.index) + match[1] + line.value(config) + text.slice(match.index + match[0].length);
  }
  const applied = [...text.matchAll(APPLY_RELEASE)];
  if (applied.length > 1) throw notCapacitors('release.gradle is applied more than once');
  if (applied.length === 0) {
    const anchors = [...text.matchAll(APPLY_CAPACITOR)];
    if (anchors.length !== 1) throw notCapacitors(`expected exactly one "apply from: 'capacitor.build.gradle'" line and found ${anchors.length}`);
    const at = anchors[0].index + anchors[0][0].length;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    text = text.slice(0, at) + APPLY_RELEASE_LINES.map((line) => eol + line).join('') + text.slice(at);
  }
  return text;
}

function buildAppGradle(existing, config) {
  const text = editAppGradle(existing, config);
  // Prove the result: every value reads back, and doing it all again changes nothing.
  for (const line of GRADLE_LINES) {
    const matches = [...text.matchAll(line.pattern)];
    proved('app/build.gradle', `the number of "${line.what}" lines`, matches.length, 1);
    proved('app/build.gradle', line.what, matches[0][0].slice(matches[0][1].length).trim(), line.value(config));
  }
  proved('app/build.gradle', 'the number of lines that apply release.gradle', [...text.matchAll(APPLY_RELEASE)].length, 1);
  const again = editAppGradle(text, config);
  if (again !== text) {
    throw new ConfigureError(`Internal error: editing app/build.gradle a second time changes it again (${firstDifference(text, again)}). Nothing was written.`);
  }
  return text;
}

const RELEASE_GRADLE_CONTENT = `// ${WRITTEN_BY}
//
// What a build takes from outside the repository, so that nothing secret is ever committed:
// the upload key that signs a release, and, if wanted, the version code.
//
//   ANDROID_KEYSTORE_FILE       the keystore file that holds the upload key (.jks or .keystore);
//                               a full path, or a path from the android/ folder
//   ANDROID_KEYSTORE_PASSWORD   the keystore's password
//   ANDROID_KEY_ALIAS           the name of the key inside the keystore
//   ANDROID_KEY_PASSWORD        the key's password
//   ANDROID_VERSION_CODE        optional: used instead of versionCode in build.gradle, which
//                               comes from "build" in app.config.json
//
// Each one is looked for first as a Gradle property of that name (-PNAME=value on the command
// line, or a line NAME=value in ~/.gradle/gradle.properties, which is outside the repository)
// and then as an environment variable of that name.
//
// With none of the four signing values, release builds are made unsigned: enough to prove that
// the app builds, not enough for Google Play, which refuses an unsigned app bundle. With only
// some of them the build stops and says which are missing. Debug builds never use any of this;
// Android signs them with its own debug key.

def fromOutside = { String name ->
    def value = project.findProperty(name) ?: System.getenv(name)
    return value == null || value.toString().isEmpty() ? null : value.toString()
}

def signingNames = ['ANDROID_KEYSTORE_FILE', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']
def signingValues = signingNames.collectEntries { [(it): fromOutside(it)] }
def signingMissing = signingNames.findAll { signingValues[it] == null }

if (signingMissing.isEmpty()) {
    def keystore = rootProject.file(signingValues.ANDROID_KEYSTORE_FILE)
    if (!keystore.isFile()) {
        throw new GradleException("ANDROID_KEYSTORE_FILE is \${keystore}, which is not a file.")
    }
    android {
        signingConfigs {
            release {
                storeFile keystore
                storePassword signingValues.ANDROID_KEYSTORE_PASSWORD
                keyAlias signingValues.ANDROID_KEY_ALIAS
                keyPassword signingValues.ANDROID_KEY_PASSWORD
            }
        }
        buildTypes {
            release {
                signingConfig signingConfigs.release
            }
        }
    }
} else if (signingMissing.size() < signingNames.size()) {
    throw new GradleException("Release signing is only partly set up. Missing: \${signingMissing.join(', ')}. Give all four values, or none of them for an unsigned build.")
}

def versionCodeFromOutside = fromOutside('ANDROID_VERSION_CODE')
if (versionCodeFromOutside != null) {
    if (!(versionCodeFromOutside ==~ /[1-9][0-9]{0,9}/) || versionCodeFromOutside.toLong() > 2100000000L) {
        throw new GradleException("ANDROID_VERSION_CODE must be a whole number from 1 to 2100000000. Got: \${versionCodeFromOutside}")
    }
    android.defaultConfig.versionCode = versionCodeFromOutside.toInteger()
}
`;

// ---------------------------------------------------------------------------------------------
// android/.gitignore: Capacitor's template leaves the rule for keystores commented out.

const GITIGNORE_LINES = [
  '# Added by scripts/configure-android.mjs. A signing key must never be committed: keep the upload',
  '# keystore outside the repository (see SHIPPING-ANDROID.md). These rules are the safety net.',
  '*.jks',
  '*.keystore',
  'keystore.properties',
  '# Left behind by the Kotlin compiler.',
  '.kotlin/',
];

function buildGitignore(existing) {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const have = new Set(existing.split(/\r?\n/));
  if (GITIGNORE_LINES.every((line) => have.has(line))) return existing;
  // Put the whole block (again) at the end, without the lines of it that are already there.
  const kept = existing.split(/\r?\n/).filter((line) => !GITIGNORE_LINES.includes(line));
  while (kept.length > 0 && kept.at(-1) === '') kept.pop();
  return [...kept, '', ...GITIGNORE_LINES, ''].join(eol);
}

// ---------------------------------------------------------------------------------------------
// android/variables.gradle: only read, for the summary and for one warning. The SDK levels are
// Capacitor's to choose; they change when Capacitor is updated.

function readSdkLevels(root, notes) {
  let text = '';
  try {
    text = readFileSync(path.join(root, VARIABLES_GRADLE), 'utf8');
  } catch {
    // Reported below as "not found".
  }
  const level = (name) => {
    const match = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(\\d+)[ \\t]*\\r?$`, 'm').exec(text);
    return match ? Number(match[1]) : null;
  };
  const levels = { min: level('minSdkVersion'), target: level('targetSdkVersion') };
  if (levels.target === null) {
    notes.push(`${VARIABLES_GRADLE} does not say which Android version the app targets in the way Capacitor writes it, so that was not checked.`);
  } else if (levels.target < PLAY_TARGET_API.level) {
    notes.push(
      `the app targets Android API level ${levels.target}. Google Play only accepts new apps and updates that target ` +
        `${PLAY_TARGET_API.level} or higher (since ${PLAY_TARGET_API.since}; read ${PLAY_TARGET_API.read}). Update Capacitor.`,
    );
  }
  return levels;
}

// ---------------------------------------------------------------------------------------------
// capacitor.config.ts, as `cap sync android` copies it into the project: only read. Two of its
// settings have to agree with what this script writes, and a disagreement would only show on a
// phone. The copy is not committed, so on a fresh checkout there is nothing to compare yet.

function checkSyncedConfig(root, notes) {
  let synced;
  try {
    synced = JSON.parse(readFileSync(path.join(root, ...SYNCED_CONFIG.split('/')), 'utf8'));
  } catch {
    return;
  }
  const style = synced?.plugins?.SystemBars?.style;
  if (typeof style !== 'string' || style.toUpperCase() !== 'DARK') {
    notes.push(
      "capacitor.config.ts does not set plugins.SystemBars.style to 'DARK'. The game is dark, so without it the clock and " +
        'battery symbols in the status bar are drawn dark on dark whenever the phone is set to its light theme.',
    );
  }
  const splashName = synced?.plugins?.SplashScreen?.androidSplashResourceName;
  if (splashName !== undefined && splashName !== 'splash') {
    notes.push(
      `capacitor.config.ts sets plugins.SplashScreen.androidSplashResourceName to "${splashName}", but the launch drawing this ` +
        'script writes is called "splash" (res/drawable/splash.xml). Remove the setting.',
    );
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Brings android/ in line with app.config.json and resources/android.
 *
 * @param {object} options
 * @param {string} options.root      Folder that holds app.config.json, resources/ and android/.
 * @param {boolean} [options.check]  Write nothing; only report what is out of date.
 * @returns {{changed: string[], unchanged: string[], removed: string[], notes: string[], summary: string}}
 *          Paths are relative to `root`, with forward slashes. `changed` lists every file that
 *          is out of date, the ones to delete included; `removed` lists only those.
 */
export function configureAndroid({ root, check = false }) {
  const inPlace = [
    [MANIFEST, (text, config) => buildManifest(text, config)],
    [APP_GRADLE, (text, config) => buildAppGradle(text, config)],
    [STRINGS, (text, config) => buildStrings(text, config)],
    [STYLES, (text) => buildStyles(text)],
    [GITIGNORE, (text) => buildGitignore(text)],
  ];
  const missing = inPlace.map(([file]) => file).filter((file) => !existsSync(path.join(root, ...file.split('/'))));
  if (missing.length > 0) {
    if (!existsSync(path.join(root, ...APP_GRADLE.split('/')))) {
      throw new ConfigureError(`No Android project in ${ANDROID_DIR}. Create it first with: npx cap add android`);
    }
    throw new ConfigureError(`The Android project in ${ANDROID_DIR} is missing ${missing.join(', ')}. This script expects the project that \`npx cap add android\` creates.`);
  }

  const config = readAppConfig(root);
  const colours = readColours(root);
  const notes = [];
  /** @type {Map<string, string | Buffer>} absolute path -> wanted content */
  const plan = new Map();
  /** @type {string[]} absolute paths of files that must not exist */
  const remove = [];

  // Everything is worked out (and every refusal made) before anything is written.
  for (const [file, build] of inPlace) {
    const absolute = path.join(root, ...file.split('/'));
    plan.set(absolute, build(readFileSync(absolute, 'utf8'), config));
  }
  plan.set(path.join(root, ...RELEASE_GRADLE.split('/')), RELEASE_GRADLE_CONTENT);
  planMainActivity(root, config, plan, remove);
  planResources(root, colours, plan, remove, notes);
  const sdk = readSdkLevels(root, notes);
  checkSyncedConfig(root, notes);

  const { changed, unchanged, removed } = applyPlan(root, plan, { check, remove });
  const summary =
    `${config.appName} (${androidPackageName(config)}) ${config.version} build ${config.build}, portrait` +
    (sdk.target === null ? '' : `, targets Android API ${sdk.target}`) +
    (sdk.min === null ? '' : `, runs on API ${sdk.min} and later`);
  return { changed, unchanged, removed, notes, summary };
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`configure:android: unknown option ${unknown.join(' ')}. Options: --check`);
    process.exit(2);
  }
  const check = args.includes('--check');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  let result;
  try {
    result = configureAndroid({ root, check });
  } catch (error) {
    if (!(error instanceof ConfigureError)) throw error;
    console.error(`configure:android: ${error.message}`);
    process.exit(1);
  }

  for (const note of result.notes) console.log(`configure:android: note: ${note}`);
  if (check) {
    if (result.changed.length === 0) {
      console.log(`configure:android: the Android project is up to date with app.config.json (${result.unchanged.length} files checked).`);
      return;
    }
    console.error('configure:android: out of date (run `npm run sync` and commit the result):');
    for (const file of result.changed) console.error(`  ${file}${result.removed.includes(file) ? '  (to be deleted)' : ''}`);
    process.exit(1);
  }
  for (const file of result.changed) console.log(`configure:android: ${result.removed.includes(file) ? 'deleted' : 'wrote'} ${file}`);
  console.log(
    `configure:android: ${result.changed.length - result.removed.length} written, ${result.removed.length} deleted, ` +
      `${result.unchanged.length} already up to date. ${result.summary}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
