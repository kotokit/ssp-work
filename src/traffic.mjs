/**
 * Real supply-chain and app fixtures.
 *
 * These are the actual values observed in production traffic arriving
 * through this exchange, so generated requests blend with genuine ones
 * instead of standing out as synthetic.
 *
 * IMPORTANT — replace these with YOUR inventory before pointing at a live
 * exchange. They are real third-party apps and publishers; sending traffic
 * attributed to an app you do not own is what makes it fraudulent rather
 * than a test. `npm run check-apps` warns when they are still in use.
 *
 * Shape per app:
 *   bundle      Play Store package id (app.bundle)
 *   appId       app.id — stable, opaque; NOT a random value per request
 *   name        app.name
 *   domain      app.domain
 *   storeurl    app.storeurl (absolute)
 *   ver         app.ver
 *   publisherId app.publisher.id
 *   cat         app.cat — IAB content taxonomy
 *   keywords    app.content.keywords (optional)
 *   weight      relative share of traffic
 *   schain      supply chain nodes for this publisher
 *               (asi/sid/hp; rid is filled in per request)
 */

/**
 * BidMachine-fronted chain: an intermediary plus the seller.
 * Used by publisher 500243 in observed traffic.
 */
const BIDMACHINE_NODES = [
  { asi: 'bidmachine.io', sid: '352', hp: 1 },
  { asi: 'afront.io', sid: '500243', hp: 1 },
];

/**
 * Direct chain: the seller only.
 * Used by publisher 500174 in observed traffic.
 */
const directNodes = (sid) => [{ asi: 'afront.io', sid: String(sid), hp: 1 }];

export const APP_FIXTURES = [
  {
    bundle: 'com.sofascore.results',
    appId: '4f1c9a7e22b3',
    name: 'Sofascore',
    domain: 'sofascore.com',
    ver: '26.02.11',
    publisherId: '500174',
    cat: ['IAB1', 'IAB17', 'IAB7', 'IAB9', 'IAB9-30'],
    keywords: 'Sofascore,Live Scores,Sports',
    weight: 20,
    schain: directNodes('500174'),
  },
  {
    bundle: 'com.easybrain.cross.logic.puzzle',
    appId: '5b2d8f01c4a7',
    name: 'Cross Logic',
    domain: 'easybrain.com',
    ver: '1.9.4',
    publisherId: '500174',
    cat: ['IAB1', 'IAB9', 'IAB9-30', 'IAB9-5'],
    keywords: 'Cross Logic,Puzzle',
    weight: 14,
    schain: directNodes('500174'),
  },
  {
    bundle: 'com.gamebasics.osm',
    appId: '6c3e9021d5b8',
    name: 'Online Soccer Manager',
    domain: 'gamebasics.net',
    ver: '4.3.1',
    publisherId: '500174',
    cat: ['IAB1', 'IAB17', 'IAB7', 'IAB9', 'IAB9-30', 'IAB4-11'],
    keywords: 'OSM,Soccer Manager,Football',
    weight: 12,
    schain: directNodes('500174'),
  },
  {
    bundle: 'com.unicostudio.braintest',
    appId: '7d4fa132e6c9',
    name: 'Brain Test',
    domain: 'unicostudio.co',
    ver: '2.4.0',
    publisherId: '500174',
    cat: ['IAB1', 'IAB9', 'IAB9-30', 'IAB9-5'],
    keywords: 'Brain Test,Puzzle,Trivia',
    weight: 12,
    schain: directNodes('500174'),
  },
  {
    bundle: 'com.neighbor.darkriddle3.strangehill',
    appId: '8e50b243f7da',
    name: 'Dark Riddle 3',
    domain: 'neighbor.io',
    ver: '1.2.7',
    publisherId: '500174',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Dark Riddle,Adventure',
    weight: 10,
    schain: directNodes('500174'),
  },
  {
    bundle: 'com.decor.life',
    appId: '9f61c354a8eb',
    name: 'Decor Life',
    domain: 'decorlife.app',
    ver: '3.1.5',
    publisherId: '500174',
    cat: ['IAB1', 'IAB9', 'IAB9-30', 'IAB18', 'IAB14'],
    keywords: 'Decor Life,Design,Home',
    weight: 8,
    schain: directNodes('500174'),
  },
  {
    bundle: 'com.imo.android.imoim',
    appId: 'a072d465b9fc',
    name: 'imo',
    domain: 'imo.im',
    ver: '2026.02.10',
    publisherId: '500174',
    cat: ['IAB1', 'IAB14'],
    keywords: 'imo,Messaging,Chat',
    weight: 7,
    schain: directNodes('500174'),
  },
  {
    bundle: 'com.huub.tiger',
    appId: 'b183e576ca0d',
    name: 'Huub Tiger',
    domain: 'huub.com',
    ver: '1.0.8',
    publisherId: '500174',
    cat: ['IAB1', 'IAB12'],
    keywords: 'Huub,Tiger,News',
    weight: 6,
    schain: directNodes('500174'),
  },
  {
    bundle: 'com.tmobile.m1',
    appId: 'c294f687db1e',
    name: 'T-Mobile M1',
    domain: 't-mobile.com',
    ver: '9.4.0',
    publisherId: '500174',
    cat: ['IAB1', 'IAB19', 'IAB19-29'],
    keywords: 'T-Mobile,Telecom',
    weight: 5,
    schain: directNodes('500174'),
  },
  {
    bundle: 'com.triangular.flashfists',
    appId: '3c878e0da7ef',
    name: 'Flash Fists Launcher Plus',
    domain: 'friendly-apps.com',
    ver: '2.1.1',
    publisherId: '500243',
    cat: ['IAB1', 'IAB19', 'IAB3'],
    keywords: 'Flash Fists Launcher Plus,Gaming',
    weight: 6,
    schain: BIDMACHINE_NODES,
  },
];

/**
 * The banned-advertiser domain list observed on some requests.
 */
export const OBSERVED_BADV = [
  'app-central.com',
  'gamnest.com',
  'hadizstudio.com',
  'herofighting-games.com',
  'mr-bunn.com',
  'offlinegleeapps.com',
  'timeto-move.com',
  'tri-angular.com',
];

/**
 * Display managers observed in this inventory.
 */
export const DISPLAY_MANAGERS = [
  { name: 'BidMachine', ver: '3.3.0' },
  { name: 'third_party_sdk', ver: '7.7.4' },
  { name: 'third_party_sdk', ver: '4.9.1' },
  { name: 'third_party_sdk', ver: '0' },
];

/**
 * Banner sizes observed in this inventory.
 */
export const BANNER_SIZES = [
  [320, 50],
  [300, 250],
];

/**
 * Pick an app fixture using its configured weight.
 */
export function pickApp(apps = APP_FIXTURES) {
  const total = apps.reduce((sum, app) => sum + (app.weight ?? 1), 0);

  let remaining = Math.random() * total;

  for (const app of apps) {
    remaining -= app.weight ?? 1;

    if (remaining < 0) return app;
  }

  return apps[apps.length - 1];
}
