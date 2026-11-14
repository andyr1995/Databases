// Written by scripts/configure-android.mjs. Do not edit: `npm run sync` writes it again.
// To add code of your own, delete these three comment lines. The script then keeps the file as
// you leave it, changes only its package line, and checks that the EdgeToEdge call is still there.
package app.firstcome.puzzle;

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
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
    }
}
