-- Fuel Finder — starter schema for caching normalised live prices.
-- The backend writes to these tables from the retailer feeds; the app's
-- /api/stations endpoint reads from them. Prices are stored in pence per litre.

CREATE DATABASE IF NOT EXISTS fuel_finder;
USE fuel_finder;

CREATE TABLE IF NOT EXISTS station (
    station_id    INT AUTO_INCREMENT PRIMARY KEY,
    source_id     VARCHAR(64),               -- retailer's own site id (for upserts)
    brand         VARCHAR(64)  NOT NULL,
    name          VARCHAR(255) NOT NULL,
    address       VARCHAR(255),
    postcode      VARCHAR(16),
    latitude      DECIMAL(9,6) NOT NULL,
    longitude     DECIMAL(9,6) NOT NULL,
    UNIQUE KEY uq_source (brand, source_id)
);

CREATE TABLE IF NOT EXISTS price (
    price_id      INT AUTO_INCREMENT PRIMARY KEY,
    station_id    INT NOT NULL,
    fuel_type     ENUM('petrol','diesel','super','premium_diesel') NOT NULL,
    pence         DECIMAL(6,1) NOT NULL,     -- e.g. 138.9
    updated_at    DATETIME NOT NULL,
    CONSTRAINT fk_price_station FOREIGN KEY (station_id)
        REFERENCES station (station_id) ON DELETE CASCADE,
    UNIQUE KEY uq_station_fuel (station_id, fuel_type)
);

-- Index for the "stations near me" query.
CREATE INDEX idx_station_latlng ON station (latitude, longitude);

-- Example: cheapest petrol within a rough lat/lng box, most recent prices.
-- SELECT s.brand, s.name, s.latitude, s.longitude, p.pence
-- FROM station s
-- JOIN price p ON p.station_id = s.station_id AND p.fuel_type = 'petrol'
-- WHERE s.latitude  BETWEEN :minLat AND :maxLat
--   AND s.longitude BETWEEN :minLng AND :maxLng
-- ORDER BY p.pence ASC
-- LIMIT 50;
