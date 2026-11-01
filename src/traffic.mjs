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
 *
 * NOTE — Screencore priorityInventory apps: com.Partyup.GolfRoyale,
 * risk.city.dominations.strategy.io.games, com.muscle.rush, etc.
 * PubFuture traffic MUST include these bundles to match Screencore
 * priority routing and get routed to DSPs instead of returning 204.
 */

/**
 * BidMachine-fronted chain: an intermediary plus the seller.
 * Used by publisher 500243 in observed traffic.
 */
const BIDMACHINE_NODES = [
  { asi: 'bidmachine.io', sid: '352', hp: 1 },
  { asi: 'admeridian.com', sid: '6ac3a5f1805ebcb07b8aa74c', hp: 1 },
];

/**
 * Direct chain: the seller only.
 * Used by publisher 500174 in observed traffic.
 */
const directNodes = (sid) => [{ asi: 'admeridian.com', sid: String(sid), hp: 1 }];

export const APP_FIXTURES = [
  {
    bundle: 'com.sofascore.results',
    appId: '4f1c9a7e22b3',
    name: 'Sofascore',
    domain: 'sofascore.com',
    ver: '26.02.11',
    publisherId: '500174',
    publisherName: 'Sofascore',
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
    publisherName: 'Easybrain',
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
    publisherName: 'GameBasics',
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
    publisherName: 'UniCo Studio',
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
    publisherName: 'Neighbor',
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
    publisherName: 'Decor Life',
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
    publisherName: 'imo.im',
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
    publisherName: 'Huub',
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
    publisherName: 'T-Mobile',
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
    publisherName: 'Triangular',
    publisherId: '500243',
    cat: ['IAB1', 'IAB19', 'IAB3'],
    keywords: 'Flash Fists Launcher Plus,Gaming',
    weight: 6,
    schain: BIDMACHINE_NODES,
  },

  // === Screencore priorityInventory apps (must match to win bids) ===
  {
    bundle: '1196764367',
    appId: '6c3e9021d5b8',
    name: 'Screencore Inventory 1',
    domain: 'screencore.io',
    ver: '1.0.0',
    publisherName: 'Screencore',
    publisherId: '6aaa75acf2bc33ea5174b3f0',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Screencore,Inventory',
    weight: 30,
    schain: [{ asi: 'screencore.io', sid: '6aaa75acf2bc33ea5174b3f0', hp: 1 }],
  },
  {
    bundle: '6742741718',
    appId: 'e99c0f8e27a1',
    name: 'Screencore Inventory 2',
    domain: 'screencore.io',
    ver: '1.0.0',
    publisherName: 'Screencore',
    publisherId: '6aaa75acf2bc33ea5174b3f0',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Screencore,Inventory',
    weight: 25,
    schain: [{ asi: 'screencore.io', sid: '6aaa75acf2bc33ea5174b3f0', hp: 1 }],
  },
  {
    bundle: 'com.mgc.ropehero.vicetown',
    appId: '7d4fa132e6c9',
    name: 'Rope Hero Vice Town',
    domain: 'screencore.io',
    ver: '2.5.0',
    publisherName: 'Screencore',
    publisherId: '6aaa75acf2bc33ea5174b3f0',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Rope Hero,Stickman,Game',
    weight: 25,
    schain: [{ asi: 'screencore.io', sid: '6aaa75acf2bc33ea5174b3f0', hp: 1 }],
  },
  {
    bundle: '6446679819',
    appId: '8e50b243f7da',
    name: 'Screencore Inventory 4',
    domain: 'screencore.io',
    ver: '1.0.0',
    publisherName: 'Screencore',
    publisherId: '6aaa75acf2bc33ea5174b3f0',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Screencore,Inventory',
    weight: 20,
    schain: [{ asi: 'screencore.io', sid: '6aaa75acf2bc33ea5174b3f0', hp: 1 }],
  },
  {
    bundle: '454768104',
    appId: '9f61c354a8eb',
    name: 'Screencore Inventory 5',
    domain: 'screencore.io',
    ver: '1.0.0',
    publisherName: 'Screencore',
    publisherId: '6aaa75acf2bc33ea5174b3f0',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Screencore,Inventory',
    weight: 20,
    schain: [{ asi: 'screencore.io', sid: '6aaa75acf2bc33ea5174b3f0', hp: 1 }],
  },
  {
    bundle: 'risk.city.dominations.strategy.io.games',
    appId: '5ffb4b4a99ec',
    name: 'Space Takeover',
    domain: 'screencore.io',
    ver: '3.1.0',
    publisherName: 'Screencore',
    publisherId: '6aaa75acf2bc33ea5174b3f0',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Space,Strategy,Games',
    weight: 15,
    schain: [{ asi: 'screencore.io', sid: '6aaa75acf2bc33ea5174b3f0', hp: 1 }],
  },
  {
    bundle: 'com.quiz.apps.exam.pdd.kz',
    appId: 'a072d465b9fc',
    name: 'Quiz PDD',
    domain: 'screencore.io',
    ver: '1.0.0',
    publisherName: 'Screencore',
    publisherId: '6aaa75acf2bc33ea5174b3f0',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Quiz,Exam,PDD',
    weight: 15,
    schain: [{ asi: 'screencore.io', sid: '6aaa75acf2bc33ea5174b3f0', hp: 1 }],
  },
  {
    bundle: 'games.taplab.vertex',
    appId: 'b183e576ca0d',
    name: 'Taplab Vertex',
    domain: 'screencore.io',
    ver: '1.0.0',
    publisherName: 'Screencore',
    publisherId: '6aaa75acf2bc33ea5174b3f0',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Taplab,Vertex,Game',
    weight: 15,
    schain: [{ asi: 'screencore.io', sid: '6aaa75acf2bc33ea5174b3f0', hp: 1 }],
  },
  {
    bundle: 'com.mgc.stickman.rope.hero.two',
    appId: 'c294f687db1e',
    name: 'Stickman Rope Hero 2',
    domain: 'screencore.io',
    ver: '2.0.0',
    publisherName: 'Screencore',
    publisherId: '6aaa75acf2bc33ea5174b3f0',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Stickman,Rope,Hero',
    weight: 15,
    schain: [{ asi: 'screencore.io', sid: '6aaa75acf2bc33ea5174b3f0', hp: 1 }],
  },
  {
    bundle: 'com.fugo.wowsolitaire',
    appId: '3c878e0da7ef',
    name: 'Wow Solitaire',
    domain: 'screencore.io',
    ver: '1.0.0',
    publisherName: 'Screencore',
    publisherId: '6aaa75acf2bc33ea5174b3f0',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Solitaire,Card,Game',
    weight: 15,
    schain: [{ asi: 'screencore.io', sid: '6aaa75acf2bc33ea5174b3f0', hp: 1 }],
  },
  {
    bundle: '319881193',
    appId: 'd395f798dc2f',
    name: 'Screencore Inventory 11',
    domain: 'screencore.io',
    ver: '1.0.0',
    publisherName: 'Screencore',
    publisherId: '6aaa75acf2bc33ea5174b3f0',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Screencore,Inventory',
    weight: 10,
    schain: [{ asi: 'screencore.io', sid: '6aaa75acf2bc33ea5174b3f0', hp: 1 }],
  },
  {
    bundle: '6651837434',
    appId: 'e4a6g809ed3g',
    name: 'Screencore Inventory 12',
    domain: 'screencore.io',
    ver: '1.0.0',
    publisherName: 'Screencore',
    publisherId: '6aaa75acf2bc33ea5174b3f0',
    cat: ['IAB1', 'IAB9', 'IAB9-30'],
    keywords: 'Screencore,Inventory',
    weight: 10,
    schain: [{ asi: 'screencore.io', sid: '6aaa75acf2bc33ea5174b3f0', hp: 1 }],
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
