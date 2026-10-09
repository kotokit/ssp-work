/**
 * OpenRTB 2.6 request builder / transport
 *
 * Interface preserved for src/ssp-server.mjs:
 *
 *   buildAuctionRequest()
 *   sendAuction()
 *   extractImpPixel()
 *   fireImpression()
 *
 * Device flow:
 *
 *   UA
 *    -> parseDevice()
 *    -> normalized model
 *    -> verified DEVICE_SPECS[model]
 *    -> OpenRTB device metadata
 *
 * Important:
 *
 * - Android Build/... is NOT sent as OpenRTB device.hwv.
 * - Display information is sent only for verified device profiles.
 * - Synthetic QA identifiers are explicitly marked as synthetic.
 * - No IP/UA spoofing headers are added by the transport.
 */

import crypto from 'node:crypto';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const BANNER_SIZES = [
    [320, 50],
    [300, 250],
    [320, 480],
];

const BANNER_MIMES = [
    'image/jpeg',
    'image/png',
    'image/gif',
];

const BANNER_API = [
    2,
    3,
];

const BANNER_BATTR = [
    1,
    3,
    6,
    7,
    8,
];

const CONNECTION_TYPES = {
    UNKNOWN: 0,
    ETHERNET: 1,
    WIFI: 2,
    CELL_UNKNOWN: 3,
    CELL_2G: 4,
    CELL_3G: 5,
    CELL_4G: 6,
};

const DEVICE_TYPES = {
    MOBILE: 4,
    TABLET: 5,
};

const DEFAULT_LANGUAGE = 'en';

const DEFAULT_BID_FLOOR = 0.01;

const DEFAULT_TMAX = 500;

const DEFAULT_CURRENCY = 'USD';

/*
 * OpenRTB 2.6 device privacy flags:
 *
 * 0 = unrestricted
 * 1 = restricted
 *
 * These are defaults for synthetic QA traffic and can be overridden
 * through traffic.dnt / traffic.lmt.
 */
const DEFAULT_DNT = 0;
const DEFAULT_LMT = 0;


/* -------------------------------------------------------------------------- */
/* Device hardware profiles                                                   */
/* -------------------------------------------------------------------------- */

/*
 * These are verified hardware/display fixtures.
 *
 * device.w / device.h:
 *   physical screen pixels
 *
 * device.ppi:
 *   pixels per linear inch
 *
 * device.pxratio:
 *   physical pixels / device-independent pixels
 *
 * Do not add guessed values.
 */

const DEVICE_SPECS = {
    /* ----------------------------- Samsung -------------------------------- */

    'SM-S928U': {
        make: 'Samsung',
        marketingName: 'Galaxy S24 Ultra',

        display: {
            width: 1440,
            height: 3120,
            ppi: 505,
            pxratio: 3.5,
        },

        hwv: null,
    },

    'SM-S938U': {
        make: 'Samsung',
        marketingName: 'Galaxy S25 Ultra',

        display: {
            width: 1440,
            height: 3120,
            ppi: 498,
            pxratio: 3.5,
        },

        hwv: null,
    },

    'SM-S908U': {
        make: 'Samsung',
        marketingName: 'Galaxy S22 Ultra',

        display: {
            width: 1440,
            height: 3088,
            ppi: 500,
            pxratio: 3.5,
        },

        hwv: null,
    },

    'SM-S948U': {
        make: 'Samsung',
        marketingName: null,
        display: null,
        hwv: null,
    },

    'SM-S936U': {
        make: 'Samsung',
        marketingName: null,
        display: null,
        hwv: null,
    },

    'SM-S931U': {
        make: 'Samsung',
        marketingName: null,
        display: null,
        hwv: null,
    },

    'SM-S947U': {
        make: 'Samsung',
        marketingName: null,
        display: null,
        hwv: null,
    },

    'SM-A166U': {
        make: 'Samsung',
        marketingName: null,
        display: null,
        hwv: null,
    },

    'SM-A156U': {
        make: 'Samsung',
        marketingName: null,
        display: null,
        hwv: null,
    },

    'SM-A546U': {
        make: 'Samsung',
        marketingName: null,
        display: null,
        hwv: null,
    },

    'SM-A556U': {
        make: 'Samsung',
        marketingName: null,
        display: null,
        hwv: null,
    },

    'SM-A356U': {
        make: 'Samsung',
        marketingName: null,
        display: null,
        hwv: null,
    },

    'SM-A366U': {
        make: 'Samsung',
        marketingName: null,
        display: null,
        hwv: null,
    },

    /* ------------------------------ Google --------------------------------- */

    'Pixel 8': {
        make: 'Google',
        marketingName: 'Pixel 8',

        display: {
            width: 1080,
            height: 2400,
            ppi: 428,
            pxratio: 2.625,
        },

        hwv: null,
    },

    'Pixel 8 Pro': {
        make: 'Google',
        marketingName: 'Pixel 8 Pro',

        display: {
            width: 1344,
            height: 2992,
            ppi: 489,
            pxratio: 3,
        },

        hwv: null,
    },

    'Pixel 9': {
        make: 'Google',
        marketingName: 'Pixel 9',

        display: {
            width: 1080,
            height: 2424,
            ppi: 422,
            pxratio: 2.75,
        },

        hwv: null,
    },

    'Pixel 9 Pro': {
        make: 'Google',
        marketingName: 'Pixel 9 Pro',

        display: {
            width: 1280,
            height: 2856,
            ppi: 495,
            pxratio: 3,
        },

        hwv: null,
    },

    'Pixel 9 Pro XL': {
        make: 'Google',
        marketingName: 'Pixel 9 Pro XL',

        display: {
            width: 1344,
            height: 2992,
            ppi: 486,
            pxratio: 3,
        },

        hwv: null,
    },

    'Pixel 10': {
        make: 'Google',
        marketingName: 'Pixel 10',
        display: null,
        hwv: null,
    },

    'Pixel 10 Pro': {
        make: 'Google',
        marketingName: 'Pixel 10 Pro',
        display: null,
        hwv: null,
    },

    'Pixel 10 Pro XL': {
        make: 'Google',
        marketingName: 'Pixel 10 Pro XL',
        display: null,
        hwv: null,
    },

    /* ----------------------------- OnePlus --------------------------------- */

    'OnePlus 12': {
        make: 'OnePlus',
        marketingName: 'OnePlus 12',

        display: {
            width: 1440,
            height: 3168,
            ppi: 510,
            pxratio: 3.5,
        },

        hwv: null,
    },

    'OnePlus 12R': {
        make: 'OnePlus',
        marketingName: 'OnePlus 12R',

        display: {
            width: 1264,
            height: 2780,
            ppi: 450,
            pxratio: 3,
        },

        hwv: null,
    },

    /* ----------------------------- Motorola -------------------------------- */

    'moto g 2025': {
        make: 'Motorola',
        marketingName: 'moto g (2025)',

        display: {
            width: 720,
            height: 1604,
            ppi: 263,
            pxratio: 2,
        },

        hwv: null,
    },

    'moto g power 5G - 2024': {
        make: 'Motorola',
        marketingName: 'moto g power 5G (2024)',
        display: null,
        hwv: null,
    },

    /* ------------------------------ Xiaomi -------------------------------- */

    'Xiaomi 14 Pro': {
        make: 'Xiaomi',
        marketingName: 'Xiaomi 14 Pro',

        display: {
            width: 1440,
            height: 3200,
            ppi: 522,
            pxratio: 3.5,
        },

        hwv: null,
    },

    /* -------------------------------- ASUS --------------------------------- */

    'ASUS_AI2201_A': {
        make: 'ASUS',
        marketingName: 'ROG Phone 8',

        display: {
            width: 1080,
            height: 2400,
            ppi: 395,
            pxratio: 3,
        },

        hwv: null,
    },

    /* -------------------------------- vivo --------------------------------- */

    'V1803': {
        make: 'vivo',
        marketingName: null,
        display: null,
        hwv: null,
    },
};


/* -------------------------------------------------------------------------- */
/* Generic helpers                                                            */
/* -------------------------------------------------------------------------- */

function pick(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return undefined;
    }

    return items[
        Math.floor(Math.random() * items.length)
        ];
}

function randomUUID() {
    return crypto.randomUUID();
}

function clean(value) {
    if (
        value === undefined ||
        value === null ||
        value === ''
    ) {
        return undefined;
    }

    return value;
}

function numberOrUndefined(value) {
    const n = Number(value);

    return Number.isFinite(n)
        ? n
        : undefined;
}

function positiveIntegerOrUndefined(value) {
    const n = Number(value);

    if (!Number.isInteger(n) || n <= 0) {
        return undefined;
    }

    return n;
}

function clampInteger(value, min, max, fallback) {
    const n = Number(value);

    if (!Number.isInteger(n)) {
        return fallback;
    }

    return Math.min(
        max,
        Math.max(min, n),
    );
}


/* -------------------------------------------------------------------------- */
/* UA parsing                                                                 */
/* -------------------------------------------------------------------------- */

function parseAndroidVersion(ua) {
    const match = ua.match(
        /Android\s+([0-9]+(?:\.[0-9]+)*)/i,
    );

    return match
        ? match[1]
        : null;
}

function parseChromeVersion(ua) {
    const match = ua.match(
        /Chrome\/([0-9]+(?:\.[0-9]+){1,3})/i,
    );

    return match
        ? match[1]
        : null;
}

function parseWebViewVersion(ua) {
    const match = ua.match(
        /Version\/([0-9]+(?:\.[0-9]+)*)/i,
    );

    return match
        ? match[1]
        : null;
}

function isWebView(ua) {
    return /;\s*wv(?:[;\s)]|$)/i.test(ua);
}

function parseBuild(ua) {
    const match = ua.match(
        /Build\/([^\s;)]+)/i,
    );

    return match
        ? match[1]
        : null;
}

function parseModelFromBuild(ua) {
    const match = ua.match(
        /Android\s+[^;]+;\s*(?:[a-z]{2}-[A-Z]{2};\s*)?([^;)]+?)\s+Build\//i,
    );

    return match
        ? match[1].trim()
        : null;
}

function parseModelWithoutBuild(ua) {
    const match = ua.match(
        /Android\s+[^;]+;\s*(?:[a-z]{2}-[A-Z]{2};\s*)?([^;)]+)(?:\)|;)/i,
    );

    if (!match) {
        return null;
    }

    const model = match[1]
        .trim()
        .replace(/\s+wv$/i, '');

    return model || null;
}

function normalizeModel(model) {
    if (!model) {
        return null;
    }

    const value = model.trim();

    if (DEVICE_SPECS[value]) {
        return value;
    }

    const exact = Object.keys(DEVICE_SPECS).find(
        key =>
            key.toLowerCase() === value.toLowerCase(),
    );

    return exact || value;
}

function inferMake(model) {
    if (!model) {
        return null;
    }

    const value = model.toLowerCase();

    if (
        value.startsWith('sm-') ||
        value.startsWith('gt-') ||
        value.startsWith('sc-')
    ) {
        return 'Samsung';
    }

    if (value.startsWith('pixel')) {
        return 'Google';
    }

    if (
        value.startsWith('moto ') ||
        value.startsWith('motorola')
    ) {
        return 'Motorola';
    }

    if (value.startsWith('oneplus')) {
        return 'OnePlus';
    }

    if (
        value.startsWith('xiaomi') ||
        value.startsWith('redmi') ||
        value.startsWith('mi ')
    ) {
        return 'Xiaomi';
    }

    if (
        value.startsWith('asus_') ||
        value.startsWith('asus ')
    ) {
        return 'ASUS';
    }

    if (/^v\d{3,5}$/i.test(value)) {
        return 'vivo';
    }

    return null;
}

function parseDevice(ua) {
    if (!ua || typeof ua !== 'string') {
        throw new Error(
            'UA must be a non-empty string',
        );
    }

    const osv = parseAndroidVersion(ua);

    const webview = isWebView(ua);

    const chromeVersion =
        parseChromeVersion(ua);

    const webViewVersion =
        webview
            ? parseWebViewVersion(ua)
            : null;

    let model = parseModelFromBuild(ua);

    if (!model) {
        model = parseModelWithoutBuild(ua);
    }

    model = normalizeModel(model);

    const spec =
        model
            ? DEVICE_SPECS[model]
            : null;

    const make =
        spec?.make ||
        inferMake(model);

    /*
     * Important:
     *
     * parseBuild() is deliberately kept separate from hwv.
     *
     * Android:
     *
     *   Build/BP4A.251205.006
     *
     * is an OS build identifier, not an OpenRTB hardware version.
     */
    const androidBuild =
        parseBuild(ua);

    return {
        os: 'Android',

        osv,

        model,

        make,

        androidBuild,

        /*
         * Only a verified fixture can provide hwv.
         */
        hwv:
            spec?.hwv ||
            null,

        webview,

        browser: {
            type:
                webview
                    ? 'WebView'
                    : 'Chrome',

            chromeVersion,

            webViewVersion,
        },

        display:
            spec?.display
                ? {
                    ...spec.display,
                }
                : null,

        marketingName:
            spec?.marketingName ??
            null,

        knownModel:
            Boolean(spec),
    };
}


/* -------------------------------------------------------------------------- */
/* Device validation                                                          */
/* -------------------------------------------------------------------------- */

function validateDevice(ua, device) {
    const errors = [];
    const warnings = [];

    if (!device.osv) {
        errors.push(
            'Unable to parse Android version',
        );
    }

    if (!device.model) {
        errors.push(
            'Unable to parse Android model',
        );
    }

    if (!device.make) {
        warnings.push(
            `Unknown manufacturer for model "${device.model ?? 'unknown'}"`,
        );
    }

    if (device.webview) {
        if (!/Version\/4\.0/i.test(ua)) {
            warnings.push(
                'WebView UA does not contain Version/4.0',
            );
        }

        if (!device.browser.chromeVersion) {
            warnings.push(
                'WebView UA has no Chrome version',
            );
        }
    }

    if (
        !device.webview &&
        /Version\/4\.0/i.test(ua)
    ) {
        warnings.push(
            'UA contains Version/4.0 but is not marked as WebView',
        );
    }

    if (!device.knownModel) {
        warnings.push(
            `No verified hardware profile for "${device.model}"`,
        );
    }

    if (device.display) {
        if (
            !Number.isInteger(device.display.width) ||
            device.display.width <= 0
        ) {
            errors.push(
                'Invalid display width',
            );
        }

        if (
            !Number.isInteger(device.display.height) ||
            device.display.height <= 0
        ) {
            errors.push(
                'Invalid display height',
            );
        }

        if (
            !Number.isInteger(device.display.ppi) ||
            device.display.ppi <= 0
        ) {
            errors.push(
                'Invalid display PPI',
            );
        }

        if (
            typeof device.display.pxratio !== 'number' ||
            device.display.pxratio <= 0
        ) {
            errors.push(
                'Invalid display pixel ratio',
            );
        }
    }

    return {
        valid: errors.length === 0,

        errors,

        warnings,
    };
}


/* -------------------------------------------------------------------------- */
/* Geo                                                                        */
/* -------------------------------------------------------------------------- */

const US_METROS = {
    Boston: {
        city: 'Boston',
        state: 'MA',
        country: 'USA',
        lat: 42.3601,
        lon: -71.0589,
    },

    NewYork: {
        city: 'New York',
        state: 'NY',
        country: 'USA',
        lat: 40.7128,
        lon: -74.0060,
    },

    NewJersey: {
        city: 'Newark',
        state: 'NJ',
        country: 'USA',
        lat: 40.7357,
        lon: -74.1724,
    },

    Dallas: {
        city: 'Dallas',
        state: 'TX',
        country: 'USA',
        lat: 32.7767,
        lon: -96.7970,
    },

    Phoenix: {
        city: 'Phoenix',
        state: 'AZ',
        country: 'USA',
        lat: 33.4484,
        lon: -112.0740,
    },

    WestLafayette: {
        city: 'West Lafayette',
        state: 'IN',
        country: 'USA',
        lat: 40.4259,
        lon: -86.9081,
    },
};

function normalizeMetro(metro) {
    if (!metro) {
        return null;
    }

    return String(metro)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');
}

function geoForMetro(
    metro,
    {
        includeCoordinates = true,
    } = {},
) {
    const normalized =
        normalizeMetro(metro);

    const entry =
        Object.entries(US_METROS).find(
            ([name]) =>
                normalizeMetro(name) === normalized,
        );

    const source =
        entry?.[1] ||
        US_METROS.NewYork;

    const geo = {
        type: 2,

        country: source.country,

        region: source.state,

        city: source.city,
    };

    /*
     * Coordinates are only included when the QA configuration explicitly
     * allows them. Metro/city information can still be provided without
     * pretending that the exact device coordinate is known.
     */
    if (includeCoordinates) {
        geo.lat = source.lat;
        geo.lon = source.lon;
    }

    return geo;
}


/* -------------------------------------------------------------------------- */
/* Banner                                                                     */
/* -------------------------------------------------------------------------- */

function normalizeBannerSize(size) {
    if (
        !Array.isArray(size) ||
        size.length !== 2
    ) {
        return null;
    }

    const width =
        positiveIntegerOrUndefined(size[0]);

    const height =
        positiveIntegerOrUndefined(size[1]);

    if (!width || !height) {
        return null;
    }

    return [width, height];
}

function buildBanner(
    width,
    height,
    traffic = {},
) {
    const configured =
        normalizeBannerSize(
            traffic?.bannerSize,
        );

    const explicit =
        normalizeBannerSize([
            width,
            height,
        ]);

    const selected =
        explicit ||
        configured ||
        pick(BANNER_SIZES);

    const w = selected[0];
    const h = selected[1];

    const banner = {
        w,

        h,

        format: [
            {
                w,
                h,
            },
        ],

        mimes: Array.isArray(
            traffic?.bannerMimes,
        )
            ? [...traffic.bannerMimes]
            : [...BANNER_MIMES],

        api: Array.isArray(
            traffic?.bannerApi,
        )
            ? [...traffic.bannerApi]
            : [...BANNER_API],

        battr: Array.isArray(
            traffic?.bannerBattr,
        )
            ? [...traffic.bannerBattr]
            : [...BANNER_BATTR],
    };

    /*
     * Only send btype when there are actual blocked types.
     *
     * An empty [] carries no useful information.
     */
    if (
        Array.isArray(traffic?.bannerBtype) &&
        traffic.bannerBtype.length > 0
    ) {
        banner.btype = [
            ...traffic.bannerBtype,
        ];
    }

    /*
     * topframe has meaning in the browser/frame context.
     *
     * Don't fabricate it for an in-app WebView unless explicitly configured.
     */
    if (
        traffic?.bannerTopframe === 0 ||
        traffic?.bannerTopframe === 1
    ) {
        banner.topframe =
            traffic.bannerTopframe;
    }

    if (
        Array.isArray(traffic?.bannerPos) &&
        traffic.bannerPos.length > 0
    ) {
        banner.pos = Number(
            traffic.bannerPos[0],
        );
    }

    return banner;
}


/* -------------------------------------------------------------------------- */
/* Device identity                                                            */
/* -------------------------------------------------------------------------- */

function buildSyntheticIFA({
                               publisherId,
                               model,
                               deviceKey,
                           }) {
    /*
     * Stable identifier for a QA fixture.
     *
     * This is deliberately synthetic and should not be interpreted as
     * a real device advertising identifier.
     */

    const seed = [
        'qa',
        publisherId || '',
        model || '',
        deviceKey || '',
    ].join(':');

    const hash =
        crypto
            .createHash('sha256')
            .update(seed)
            .digest('hex');

    /*
     * UUID v4-looking synthetic identifier.
     */
    const variant =
        (
            parseInt(
                hash.slice(16, 18),
                16,
            ) & 0x3f
        ) | 0x80;

    return [
        hash.slice(0, 8),

        hash.slice(8, 12),

        `4${hash.slice(13, 16)}`,

        `${variant.toString(16)}${hash.slice(18, 20)}`,

        hash.slice(20, 32),
    ].join('-');
}


/* -------------------------------------------------------------------------- */
/* Carrier                                                                    */
/* -------------------------------------------------------------------------- */

function buildCarrier(traffic) {
    /*
     * ISP and mobile carrier are different concepts.
     *
     * Never derive carrier/mccmnc from traffic.isp.
     */

    const carrier =
        traffic?.carrier;

    if (!carrier) {
        return {};
    }

    if (typeof carrier === 'string') {
        return {
            carrier,
        };
    }

    if (
        typeof carrier === 'object' &&
        carrier.name
    ) {
        return {
            carrier: carrier.name,

            ...(carrier.mccmnc
                ? {
                    mccmnc: String(
                        carrier.mccmnc,
                    ),
                }
                : {}),
        };
    }

    return {};
}


/* -------------------------------------------------------------------------- */
/* Supply chain                                                               */
/* -------------------------------------------------------------------------- */

function buildSchain(
    traffic = {},
    publisherId,
) {
    const schain =
        traffic?.schain;

    if (
        schain &&
        typeof schain === 'object' &&
        Array.isArray(schain.nodes)
    ) {
        return {
            ...schain,

            nodes: schain.nodes.map(
                node => ({
                    ...node,
                }),
            ),
        };
    }

    return {
        ver: '1.0',

        complete:
            traffic?.schainComplete === 0
                ? 0
                : 1,

        nodes: [
            {
                asi:
                    traffic?.asi ||
                    'qa.example',

                sid: String(
                    traffic?.sid ||
                    publisherId ||
                    'qa-supply',
                ),

                hp: 1,
            },
        ],
    };
}


/* -------------------------------------------------------------------------- */
/* Build Device                                                               */
/* -------------------------------------------------------------------------- */

function buildDevice({
                         ua,
                         ip,
                         parsed,
                         publisherId,
                         geoMeta,
                         traffic,
                     }) {
    const display =
        parsed.display || {};

    const deviceKey =
        traffic?.deviceKey ||
        `${parsed.make || 'unknown'}:${parsed.model || 'unknown'}`;

    const ifa =
        traffic?.ifa ||
        buildSyntheticIFA({
            publisherId,
            model: parsed.model,
            deviceKey,
        });

    const device = {
        ua,

        /*
         * IP is part of the OpenRTB Device object.
         */
        ...(ip
            ? {
                ip: String(ip),
            }
            : {}),

        devicetype:
            Number.isInteger(
                traffic?.devicetype,
            )
                ? traffic.devicetype
                : DEVICE_TYPES.MOBILE,

        make:
            clean(parsed.make),

        model:
            clean(parsed.model),

        os: 'Android',

        osv:
            clean(parsed.osv),

        /*
         * IMPORTANT:
         *
         * We do NOT send parsed.androidBuild here.
         *
         * OpenRTB hwv means hardware version, not Android Build ID.
         */
        ...(parsed.hwv
            ? {
                hwv: parsed.hwv,
            }
            : {}),

        js:
            traffic?.js === 0
                ? 0
                : 1,

        language:
            traffic?.language ||
            DEFAULT_LANGUAGE,

        connectiontype:
            Number.isInteger(
                traffic?.connectiontype,
            )
                ? traffic.connectiontype
                : CONNECTION_TYPES.WIFI,

        ifa: String(ifa),

        geo: geoForMetro(
            geoMeta?.metro,
            {
                includeCoordinates:
                    traffic?.geoCoordinates !== false,
            },
        ),

        /*
         * Privacy signals.
         */
        dnt:
            traffic?.dnt === 1
                ? 1
                : DEFAULT_DNT,

        lmt:
            traffic?.lmt === 1
                ? 1
                : DEFAULT_LMT,
    };

    /*
     * Only add verified physical display properties.
     */
    if (
        Number.isInteger(
            display.width,
        ) &&
        display.width > 0
    ) {
        device.w =
            display.width;
    }

    if (
        Number.isInteger(
            display.height,
        ) &&
        display.height > 0
    ) {
        device.h =
            display.height;
    }

    if (
        Number.isInteger(
            display.ppi,
        ) &&
        display.ppi > 0
    ) {
        device.ppi =
            display.ppi;
    }

    if (
        typeof display.pxratio === 'number' &&
        display.pxratio > 0
    ) {
        device.pxratio =
            display.pxratio;
    }

    /*
     * Carrier is independent from ISP.
     */
    Object.assign(
        device,
        buildCarrier(traffic),
    );

    /*
     * QA-only metadata.
     *
     * This is intentionally not pretending to be standard OpenRTB.
     */
    device.ext = {
        qa: {
            synthetic: true,

            browser:
            parsed.browser.type,

            webview:
            parsed.webview,

            knownModel:
            parsed.knownModel,

            ...(parsed.androidBuild
                ? {
                    androidBuild:
                    parsed.androidBuild,
                }
                : {}),
        },
    };

    return device;
}


/* -------------------------------------------------------------------------- */
/* Build App                                                                  */
/* -------------------------------------------------------------------------- */

function buildApp({
                      bundle,
                      appName,
                      publisherId,
                      traffic,
                  }) {
    const app = {
        id: String(
            traffic?.appId ||
            publisherId,
        ),

        name:
            appName ||
            traffic?.appName ||
            bundle,

        bundle: String(bundle),

        publisher: {
            id: String(
                traffic?.publisherId ||
                publisherId,
            ),
        },
    };

    if (traffic?.appDomain) {
        app.domain =
            String(traffic.appDomain);
    }

    if (traffic?.storeurl) {
        app.storeurl =
            String(traffic.storeurl);
    }

    if (traffic?.appVersion) {
        app.ver =
            String(traffic.appVersion);
    }

    if (traffic?.publisherName) {
        app.publisher.name =
            String(traffic.publisherName);
    }

    if (traffic?.publisherDomain) {
        app.publisher.domain =
            String(traffic.publisherDomain);
    }

    if (
        Array.isArray(traffic?.appCat) &&
        traffic.appCat.length > 0
    ) {
        app.cat = [
            ...traffic.appCat,
        ];
    }

    return app;
}


/* -------------------------------------------------------------------------- */
/* Build Video                                                                */
/* -------------------------------------------------------------------------- */

function buildVideo(traffic = {}) {
    const video = {
        mimes:
            Array.isArray(
                traffic?.videoMimes,
            )
                ? [...traffic.videoMimes]
                : [
                    'video/mp4',
                    'video/webm',
                ],

        minduration:
            Number.isInteger(
                traffic?.videoMinDuration,
            )
                ? traffic.videoMinDuration
                : 5,

        maxduration:
            Number.isInteger(
                traffic?.videoMaxDuration,
            )
                ? traffic.videoMaxDuration
                : 60,

        protocols:
            Array.isArray(
                traffic?.videoProtocols,
            )
                ? [...traffic.videoProtocols]
                : [
                    2,
                    3,
                    5,
                    6,
                ],

        linearity:
            Number.isInteger(
                traffic?.videoLinearity,
            )
                ? traffic.videoLinearity
                : 1,
    };

    const width =
        positiveIntegerOrUndefined(
            traffic?.videoWidth,
        );

    const height =
        positiveIntegerOrUndefined(
            traffic?.videoHeight,
        );

    if (width) {
        video.w = width;
    }

    if (height) {
        video.h = height;
    }

    if (
        Number.isInteger(
            traffic?.videoPlacement,
        )
    ) {
        video.placement =
            traffic.videoPlacement;
    }

    if (
        Array.isArray(
            traffic?.videoPlaybackmethod,
        ) &&
        traffic.videoPlaybackmethod.length > 0
    ) {
        video.playbackmethod = [
            ...traffic.videoPlaybackmethod,
        ];
    }

    if (
        Number.isInteger(
            traffic?.videoStartdelay,
        )
    ) {
        video.startdelay =
            traffic.videoStartdelay;
    }

    return video;
}


/* -------------------------------------------------------------------------- */
/* Build auction request                                                      */
/* -------------------------------------------------------------------------- */

function buildAuctionRequest({
                                 ua,
                                 ip,
                                 bundle,
                                 appName,
                                 publisherId,
                                 format = 'banner',
                                 bidfloor = DEFAULT_BID_FLOOR,
                                 geoMeta = {},
                                 traffic = {},
                             }) {
    if (!ua || typeof ua !== 'string') {
        throw new Error(
            'ua is required',
        );
    }

    if (!bundle || typeof bundle !== 'string') {
        throw new Error(
            'bundle is required',
        );
    }

    if (
        publisherId === undefined ||
        publisherId === null ||
        String(publisherId).trim() === ''
    ) {
        throw new Error(
            'publisherId is required',
        );
    }

    if (
        format !== 'banner' &&
        format !== 'video'
    ) {
        throw new Error(
            `Unsupported format: ${format}`,
        );
    }

    const parsed =
        parseDevice(ua);

    const validation =
        validateDevice(
            ua,
            parsed,
        );

    if (!validation.valid) {
        throw new Error(
            [
                'Invalid UA/device fixture:',
                ...validation.errors.map(
                    error => `- ${error}`,
                ),
            ].join('\n'),
        );
    }

    const requestId =
        randomUUID();

    const normalizedFloor =
        Number.isFinite(
            Number(bidfloor),
        )
            ? Math.max(
                0,
                Number(bidfloor),
            )
            : DEFAULT_BID_FLOOR;

    const imp = {
        id: String(
            traffic?.impId ||
            '1',
        ),

        bidfloor:
        normalizedFloor,
    };

    if (format === 'video') {
        imp.video =
            buildVideo(traffic);
    } else {
        imp.banner =
            buildBanner(
                traffic?.bannerWidth,
                traffic?.bannerHeight,
                traffic,
            );
    }

    const device =
        buildDevice({
            ua,
            ip,
            parsed,
            publisherId,
            geoMeta,
            traffic,
        });

    const app =
        buildApp({
            bundle,
            appName,
            publisherId,
            traffic,
        });

    const request = {
        id: requestId,

        /*
         * Explicit QA mode.
         *
         * OpenRTB test=1 means the auction is non-billable.
         */
        test: 1,

        at:
            Number.isInteger(
                traffic?.at,
            )
                ? traffic.at
                : 1,

        tmax:
            clampInteger(
                traffic?.tmax,
                1,
                10000,
                DEFAULT_TMAX,
            ),

        cur:
            Array.isArray(
                traffic?.cur,
            ) &&
            traffic.cur.length > 0
                ? traffic.cur.map(
                    String,
                )
                : [DEFAULT_CURRENCY],

        imp: [
            imp,
        ],

        app,

        device,

        source: {
            /*
             * Exchange makes the final sale decision.
             */
            fd:
                traffic?.sourceFd === 1
                    ? 1
                    : 0,

            tid: requestId,

            schain:
                buildSchain(
                    traffic,
                    publisherId,
                ),
        },

        regs: {
            coppa:
                traffic?.coppa === 1
                    ? 1
                    : 0,
        },
    };

    /*
     * Optional GPP.
     */
    if (
        typeof traffic?.gpp === 'string' &&
        traffic.gpp.length > 0
    ) {
        request.regs.gpp =
            traffic.gpp;
    }

    if (
        Array.isArray(
            traffic?.gpp_sid,
        ) &&
        traffic.gpp_sid.length > 0
    ) {
        request.regs.gpp_sid =
            traffic.gpp_sid.map(
                Number,
            );
    }

    /*
     * Optional request-level restrictions.
     */
    if (
        Array.isArray(
            traffic?.bcat,
        ) &&
        traffic.bcat.length > 0
    ) {
        request.bcat = [
            ...traffic.bcat,
        ];
    }

    if (
        Array.isArray(
            traffic?.badv,
        ) &&
        traffic.badv.length > 0
    ) {
        request.badv = [
            ...traffic.badv,
        ];
    }

    if (
        Array.isArray(
            traffic?.bapp,
        ) &&
        traffic.bapp.length > 0
    ) {
        request.bapp = [
            ...traffic.bapp,
        ];
    }

    /*
     * Optional request-level test metadata.
     */
    if (traffic?.qaExt !== false) {
        request.ext = {
            qa: {
                synthetic: true,
                generator: 'openrtb-load-test',
            },
        };
    }

    return request;
}


/* -------------------------------------------------------------------------- */
/* Auction transport                                                          */
/* -------------------------------------------------------------------------- */

async function readResponseBody(
    response,
) {
    const text =
        await response.text();

    if (!text) {
        return {
            text: '',
            json: null,
        };
    }

    try {
        return {
            text,

            json:
                JSON.parse(text),
        };
    } catch {
        return {
            text,

            json: null,
        };
    }
}

async function sendAuction(
    body,
    {
        auctionUrl,
        supplyKey,
        timeoutMs = 5000,
    } = {},
) {
    if (!auctionUrl) {
        throw new Error(
            'auctionUrl is required',
        );
    }

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () => controller.abort(),
            timeoutMs,
        );

    try {
        const headers = {
            'content-type':
                'application/json',

            accept:
                'application/json',

            /*
             * Explicit QA marker.
             */
            'x-qa-test':
                '1',
        };

        if (supplyKey) {
            headers['x-supply-key'] =
                supplyKey;
        }

        const response =
            await fetch(
                auctionUrl,
                {
                    method: 'POST',

                    headers,

                    body:
                        JSON.stringify(body),

                    signal:
                    controller.signal,
                },
            );

        const result =
            await readResponseBody(
                response,
            );

        return {
            status:
            response.status,

            headers:
                Object.fromEntries(
                    response.headers.entries(),
                ),

            text:
            result.text,

            json:
            result.json,

            ok:
            response.ok,
        };
    } catch (error) {
        return {
            status: 0,

            headers: {},

            text: '',

            json: null,

            ok: false,

            error:
                error?.name === 'AbortError'
                    ? `Auction request timed out after ${timeoutMs}ms`
                    : String(error),
        };
    } finally {
        clearTimeout(timeout);
    }
}


/* -------------------------------------------------------------------------- */
/* Impression URL extraction                                                  */
/* -------------------------------------------------------------------------- */

function decodeHtmlEntities(
    value,
) {
    return String(value)
        .replace(
            /&amp;/gi,
            '&',
        )
        .replace(
            /&quot;/gi,
            '"',
        )
        .replace(
            /&#39;/gi,
            "'",
        )
        .replace(
            /&#x2f;/gi,
            '/',
        )
        .replace(
            /&#x3d;/gi,
            '=',
        );
}

function extractImpPixel(
    response,
) {
    if (!response) {
        return null;
    }

    const payload =
        response?.json &&
        typeof response.json === 'object'
            ? response.json
            : response;

    const creatives = [];

    if (
        Array.isArray(
            payload?.seatbid,
        )
    ) {
        for (
            const seat of payload.seatbid
            ) {
            if (
                !Array.isArray(
                    seat?.bid,
                )
            ) {
                continue;
            }

            for (
                const bid of seat.bid
                ) {
                if (bid?.adm) {
                    creatives.push(
                        String(bid.adm),
                    );
                }

                if (bid?.nurl) {
                    creatives.push(
                        String(bid.nurl),
                    );
                }
            }
        }
    }

    if (payload?.adm) {
        creatives.push(
            String(payload.adm),
        );
    }

    if (payload?.creative) {
        creatives.push(
            String(payload.creative),
        );
    }

    for (
        const creative of creatives
        ) {
        const decoded =
            decodeHtmlEntities(
                creative,
            );

        const absolute =
            decoded.match(
                /https?:\/\/[^\s"'<>]+\/t\/imp\?e=[^"'<>\s]+/i,
            );

        if (absolute) {
            return absolute[0];
        }

        const relative =
            decoded.match(
                /\/t\/imp\?e=[^"'<>\s]+/i,
            );

        if (relative) {
            return relative[0];
        }
    }

    return null;
}


/* -------------------------------------------------------------------------- */
/* Impression transport                                                       */
/* -------------------------------------------------------------------------- */

async function fireImpression(
    pixel,
    {
        timeoutMs = 5000,
        headers = {},
    } = {},
) {
    if (!pixel) {
        throw new Error(
            'Impression URL is empty',
        );
    }

    let url;

    try {
        url =
            new URL(pixel);
    } catch {
        throw new Error(
            `Invalid impression URL: ${pixel}`,
        );
    }

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () => controller.abort(),
            timeoutMs,
        );

    try {
        const response =
            await fetch(
                url,
                {
                    method: 'GET',

                    redirect: 'manual',

                    headers: {
                        accept: '*/*',

                        'x-qa-test': '1',

                        ...headers,
                    },

                    signal:
                    controller.signal,
                },
            );

        return response.status;
    } catch (error) {
        if (
            error?.name ===
            'AbortError'
        ) {
            throw new Error(
                `Impression request timed out after ${timeoutMs}ms`,
            );
        }

        throw error;
    } finally {
        clearTimeout(timeout);
    }
}


/* -------------------------------------------------------------------------- */
/* QA helpers                                                                 */
/* -------------------------------------------------------------------------- */

function analyzeUA(ua) {
    const parsed =
        parseDevice(ua);

    const validation =
        validateDevice(
            ua,
            parsed,
        );

    return {
        ua,

        parsed,

        validation,
    };
}

function validateUAList(
    userAgents,
) {
    if (!Array.isArray(userAgents)) {
        throw new Error(
            'userAgents must be an array',
        );
    }

    return userAgents.map(
        (ua, index) => {
            try {
                const result =
                    analyzeUA(ua);

                return {
                    index,

                    valid:
                    result.validation.valid,

                    model:
                    result.parsed.model,

                    make:
                    result.parsed.make,

                    android:
                    result.parsed.osv,

                    androidBuild:
                    result.parsed.androidBuild,

                    browser:
                    result.parsed.browser.type,

                    chrome:
                    result.parsed.browser.chromeVersion,

                    webview:
                    result.parsed.webview,

                    knownModel:
                    result.parsed.knownModel,

                    display:
                    result.parsed.display,

                    errors:
                    result.validation.errors,

                    warnings:
                    result.validation.warnings,
                };
            } catch (error) {
                return {
                    index,

                    valid: false,

                    model: null,

                    make: null,

                    android: null,

                    androidBuild: null,

                    browser: null,

                    chrome: null,

                    webview: false,

                    knownModel: false,

                    display: null,

                    errors: [
                        String(error),
                    ],

                    warnings: [],
                };
            }
        },
    );
}

function printUAReport(
    userAgents,
) {
    const results =
        validateUAList(
            userAgents,
        );

    for (
        const result of results
        ) {
        console.log('');

        console.log(
            `#${result.index + 1} ` +
            `${result.make || 'Unknown'} ` +
            `${result.model || 'Unknown'}`,
        );

        console.log(
            `Android: ${result.android || 'unknown'}`,
        );

        console.log(
            `Android build: ${result.androidBuild || 'unknown'}`,
        );

        console.log(
            `Browser: ${result.browser || 'unknown'}`,
        );

        console.log(
            `Chrome: ${result.chrome || 'unknown'}`,
        );

        console.log(
            `WebView: ${
                result.webview
                    ? 'yes'
                    : 'no'
            }`,
        );

        console.log(
            `Known hardware profile: ${
                result.knownModel
                    ? 'yes'
                    : 'no'
            }`,
        );

        if (result.display) {
            console.log(
                `Display: ${result.display.width}x${result.display.height}`,
            );

            console.log(
                `PPI: ${result.display.ppi}`,
            );

            console.log(
                `Pixel ratio: ${result.display.pxratio}`,
            );
        } else {
            console.log(
                'Display: no verified profile',
            );
        }

        if (result.errors.length) {
            console.log(
                'Errors:',
                result.errors,
            );
        }

        if (result.warnings.length) {
            console.log(
                'Warnings:',
                result.warnings,
            );
        }
    }

    return results;
}


/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

export {
    buildAuctionRequest,
    sendAuction,
    extractImpPixel,
    fireImpression,

    parseDevice,
    validateDevice,

    analyzeUA,
    validateUAList,
    printUAReport,

    DEVICE_SPECS,
    CONNECTION_TYPES,
    DEVICE_TYPES,
};