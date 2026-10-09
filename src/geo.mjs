
const maxmind = require('maxmind');
const countries = require('i18n-iso-countries');

countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

let reader;

async function initGeoIP() {
    reader = await maxmind.open(
        '/path/to/GeoLite2-City.mmdb'
    );
}

function getGeo(ip) {
    if (!reader) {
        throw new Error('GeoIP database is not initialized');
    }

    const result = reader.get(ip);

    if (!result) return null;

    const location = result.location || {};
    const countryCode = result.country?.iso_code;

    return {
        country: countryCode
            ? countries.alpha2ToAlpha3(countryCode)
            : undefined,
        type: 2,
        lat: location.latitude,
        lon: location.longitude,
        region: result.subdivisions?.[0]?.iso_code,
        city: result.city?.names?.en,
        metro: result.location?.metro_code != null
            ? String(result.location.metro_code)
            : undefined,
        zip: result.postal?.code,
        accuracy: location.accuracy_radius,
    };
}

module.exports = { initGeoIP, getGeo };