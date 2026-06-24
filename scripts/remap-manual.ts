// scripts/remap-manual.ts
// Assigns new categories to items that were flagged MANUAL by remap-categories.ts.
// Uses keyword matching on item name to decide the correct new category.
// Run (dry run): npx tsx scripts/remap-manual.ts
// Run (apply):   npx tsx scripts/remap-manual.ts --apply

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const CSV_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data/pricebook.csv'
);

const APPLY = process.argv.includes('--apply');

const NEW_CATS = new Set([
  'Service Calls & Diagnostics',
  'Panel Upgrades',
  'Service Entrance',
  'New Circuits & Wiring',
  'EV Charger',
  'Generator',
  'Ceiling Fans & Fixtures',
  'Switches, Outlets & Devices',
  'Surge Protection',
  'Grounding & Bonding',
  'Low Voltage',
  'Underground & Trenching',
  'Remodel — Rough-In',
  'Remodel — Trim-Out',
  'Commercial',
  'Conduit — Materials',
  'Wire & Cable — Materials',
  'Permits & Inspections',
  'Fees & Adjustments',
]);

// ponytail: UUID-keyed overrides take precedence over keyword matching
const UUID_OVERRIDES: Record<string, string> = {
  // ── Service Entrance and Panel → split by item ──────────────────────────────
  'olit_74533089f1f9442db8afa2fdb545b70e': 'Panel Upgrades',          // 200A Main Breaker
  'olit_e09db38595ba453c92c15535b698abb8': 'Service Entrance',        // 200A Meter Enclosure
  'olit_3acfe6eaf34944a3b4c95ee58ad48cb2': 'Panel Upgrades',          // 200A Panel Enclosure
  'olit_78d92d8882a44e8b8d11558305009586': 'Panel Upgrades',          // Arc Fault Breaker Upgrade
  'olit_1595557898f34baba8cecb6d7d720e0e': 'Fees & Adjustments',      // Custom Job
  'olit_a7ca02bd61f04e3da3408e8fa5927ebb': 'Grounding & Bonding',     // Grounding and Bonding
  'olit_47e935ada7174bad9aae1a7a7d303b5d': 'Service Entrance',        // Install Meter Slip Joint
  'olit_f52958bfba57453abf01c4712047b90d': 'Panel Upgrades',          // Install New 60A Sub Panel
  'olit_eb1b90008e384c6dbfbf2c32997d4c83': 'Service Entrance',        // Install New Overhead Service Riser
  'olit_2c1b3a4b7d8c489b9acc9f530b54fc4a': 'Panel Upgrades',          // Install Wire Grommets (panel work)
  'olit_f35162217fec46699cc2cc412952909e': 'Panel Upgrades',          // Relocate Panel
  'olit_443d5f6e304e4448924ae9533810b7b3': 'Service Entrance',        // Service Disconnect
  'olit_481a91e21dc844e09e2af7066d6dc366': 'Service Entrance',        // Upgrade 200a → 400a underground
  'olit_e2a078f3acb24446a191331d28fbffc0': 'Commercial',              // WAP Installation - Commercial

  // ── Install items with specific routing ─────────────────────────────────────
  'olit_fd1fc130aaac41bcaa43300d018aa5ce': 'Switches, Outlets & Devices',  // Replace GFCI Receptacle
  'olit_ca77967f41f648ce9153cb5efb704160': 'Switches, Outlets & Devices',  // Add New Receptacle
  'olit_0454ecfb6870430eae798a5b04205afe': 'Ceiling Fans & Fixtures',      // Add New Switch and Fixture
  'olit_ea2f7e83c83549d49c9b57f7aaf8e42e': 'Switches, Outlets & Devices',  // Add Receptacle By Penetrating...
  'olit_87d669e69422460184c2fb227e43a1de': 'Ceiling Fans & Fixtures',      // Assembly of Light Fixture
  'olit_f5df52625b7b45828f3e3d8913acaf78': 'New Circuits & Wiring',        // Attic Open Splice Repair
  'olit_fe7641c2c9c34c16bc59d4984441b4ca': 'Ceiling Fans & Fixtures',      // Ceiling Fan (Over 12')
  'olit_732b895747ec4919afd569fd451010c3': 'Ceiling Fans & Fixtures',      // Ceiling Fan (Up To 12')
  'olit_729bb081818a4b9082bfbb768e85447a': 'Ceiling Fans & Fixtures',      // Chandelier Crystal Installation
  'olit_e2775e76a679424a90eeca94b5973c40': 'Underground & Trenching',      // Dig Trench In Soft Ground
  'olit_de971b3201e048cbafa8a7ef55cbcb4b': 'Ceiling Fans & Fixtures',      // Fan and Light Separation
  'olit_171e4ef68f33452faf4677170df1428c': 'Low Voltage',                  // Front Smart Video Doorbell
  'olit_92cbe684166c46f3a8053207ad0d60c6': 'Panel Upgrades',               // GFCI/AFCI Breaker
  'olit_944095cd532c4ef4b81a07ef9ad85130': 'Low Voltage',                  // Hang Flat Panel TV (in-wall)
  'olit_53543cfdb9e14312a6938c93cd31a78e': 'Low Voltage',                  // Hang Flat Panel TV (no wiring)
  'olit_aa8d317cd94c4c3aabe2818438a022a2': 'Low Voltage',                  // Hang Flat Panel TV (no wiring)
  'olit_5af6a0810e034fb4be321ef1b9065fac': 'Switches, Outlets & Devices',  // In-use Cover
  'olit_ba353575e86d46b0baed62c11bf780c4': 'Service Entrance',             // Install 100 amp disconnect
  'olit_2fcf3eda1db74e63af0cc1c5c70139e0': 'New Circuits & Wiring',        // Install 18 SEER Mini Split
  'olit_b45286551a36435f883c2484d625624c': 'Commercial',                   // Install 24x24x12 NEMA 4X Enclosure
  'olit_53409779b3f24b0f903fdd4b1eeaa4bb': 'Service Entrance',             // Install 50a Spa Disconnect
  'olit_001c39643db44e70a5d5e7f23b995108': 'New Circuits & Wiring',        // Install AC Soft Starter
  'olit_b28c9a04204c441faa5a7a81e0d3c4cb': 'Switches, Outlets & Devices',  // Install Al To CU Pigtails
  'olit_7eeff2eae16a4f5b91f443583afa3205': 'Ceiling Fans & Fixtures',      // Install Ballast Bypass LED Tubes
  'olit_473b2718cc434d369d9d745bb9a43882': 'Ceiling Fans & Fixtures',      // Install Ballast Bypass LED Tubes
  'olit_d0a9545e36ec40d9a857e71f9cac2d1e': 'Conduit — Materials',          // Install Conduit (1.25"-2")
  'olit_0d7d90dff5b74cae99548385c1ee2ef4': 'Conduit — Materials',          // Install Conduit (1/2"-1")
  'olit_6bf98ab4f08545fc9121429c314add14': 'Switches, Outlets & Devices',  // Install Dimmer Switch
  'olit_e9fdb4a6b3304e79aff539dad1859f31': 'New Circuits & Wiring',        // Install Dryer Plug
  'olit_9973b39713184b949eada96017e77ee5': 'EV Charger',                   // Install EV Car Charger
  'olit_ca9a369c58934da984207dc25d8a094e': 'Ceiling Fans & Fixtures',      // Install Fence Light
  'olit_db146e0950b94365a8b54a7d63837dff': 'Switches, Outlets & Devices',  // Install GFCI
  'olit_5c568af955fd47a6a72cc074ac47c278': 'Low Voltage',                  // Install Keypad Pole and Keypad
  'olit_1ca387852fbe4031b1124008b09c0124': 'Ceiling Fans & Fixtures',      // Install LED Flat Panel
  'olit_46e2218fd7fe4c19a566769058601e94': 'New Circuits & Wiring',        // Install New 15/20a Circuit
  'olit_47a989535b5d4c37b4d59b75ceee3ad3': 'New Circuits & Wiring',        // Install New 220v 30a Circuit
  'olit_e223ca3cf26e45c68c86e5e3826e8d83': 'New Circuits & Wiring',        // Install New 220v 50a Circuit
  'olit_7ebf866768694200b9be36436f39b069': 'Ceiling Fans & Fixtures',      // Install New Aftermarket Fan/Light Remote
  'olit_00957156612143a5aeb50cd1fe3fa515': 'Low Voltage',                  // Install New Camera
  'olit_e6ab2b2d892b40f7ad057130b2a902fa': 'Commercial',                   // Install New CT Meter Bank
  'olit_8419fd9255ee4b46bf5519ba11235e1b': 'Low Voltage',                  // Install New Doorbell Transformer
  'olit_1f6e29b7b7524747adf49913cbf23346': 'Ceiling Fans & Fixtures',      // Install New LED Slim Can Light (No Access)
  'olit_3e10caaa27364d9bad0b41cc4a1900df': 'Ceiling Fans & Fixtures',      // Install New LED Slim Can Light (Open Access)
  'olit_ef13caacfeb043e9ae796c0e87254013': 'Ceiling Fans & Fixtures',      // Install New Low Voltage Landscape Lights
  'olit_336ab1fb2e9845e9a693945ba3ba9f74': 'Ceiling Fans & Fixtures',      // Install New Low Voltage Landscape Transformer
  'olit_81512232ef82466bbae73085db6cb6c2': 'Ceiling Fans & Fixtures',      // Install New Photocell
  'olit_b193fba910d64043976b5da018de2293': 'Low Voltage',                  // Install New Ring Camera
  'olit_80d303ae159a4050b686f95da87a3493': 'Ceiling Fans & Fixtures',      // Install Old Work Fixture Box
  'olit_f98d25d209fb41c0889c1c3ff4c32b51': 'Ceiling Fans & Fixtures',      // Install Pool Light
  'olit_7aed40b30ab34b92aa5c6069f584d7d1': 'Ceiling Fans & Fixtures',      // Install Remodel Fan Box
  'olit_7cdbcce3bc15444693a6fc1e861d7109': 'Ceiling Fans & Fixtures',      // Install RGB Low Voltage Landscape Lights
  'olit_6b19e190d07d4304bb0ea5a904b4313c': 'Ceiling Fans & Fixtures',      // Install RGB Pool Light
  'olit_5819fa6e922d40bfa82484c4c342abdd': 'Switches, Outlets & Devices',  // Install Smart Switch
  'olit_992f9fb8bc66401496f3bdb3f2584dcb': 'Low Voltage',                  // Install TV Back Lights
  'olit_62b55b63248547aba2feb245a8f1e89d': 'Ceiling Fans & Fixtures',      // Install Under Cabinet Light
  'olit_b97f048ca9d8412c9e19841b4a047de7': 'Switches, Outlets & Devices',  // Install Wireless 3-Way
  'olit_4cbb502db4624bceaa30aaacf96b08e9': 'Service Calls & Diagnostics',  // Make Safe
  'olit_70cfa7f77abd41f380b7099752df483c': 'Ceiling Fans & Fixtures',      // Provide and Install Bulb
  'olit_f15c754f321b4f9e964921a7207fa5f2': 'Switches, Outlets & Devices',  // Quad Receptacle
  'olit_a5ebbf5a55e54d5783e0bc9a85eed4b2': 'EV Charger',                   // Remove EV Level 2 Charger
  'olit_78563b9bdcfc4df7a4d7e256deb7c123': 'Ceiling Fans & Fixtures',      // Repair Light Fixture
  'olit_d008a1ff62ae4756afde2b54884b5a77': 'Fees & Adjustments',           // Repair Sheetrock Holes
  'olit_fc5e417e5bc844deb0afa6065fb63f94': 'Panel Upgrades',               // Replace 2-pole Breaker
  'olit_0b48eb73609047d9b1d5bac6fce1527a': 'Panel Upgrades',               // Replace Breaker
  'olit_7cebfc9b859648348388708890f5055c': 'Ceiling Fans & Fixtures',      // Replace Chandelier (10'-15')
  'olit_1402df290e084239815dffb4fecae449': 'Ceiling Fans & Fixtures',      // Replace Chandelier (15'- 19')
  'olit_ffd264ef56834172b97f1421b2248e0d': 'Ceiling Fans & Fixtures',      // Replace Chandelier (over 16')
  'olit_743dc02b928449b3ae179cbd10e67c4a': 'Commercial',                   // Replace CT Meter
  'olit_72d0034c97874592945fdf1037c2ede5': 'Ceiling Fans & Fixtures',      // Replace Exhaust Fan
  'olit_dbd26723591e448094ab8550ac276b21': 'Ceiling Fans & Fixtures',      // Replace Light Fixture (Company Provided)
  'olit_95f8ba022418454f9d463610b567e7d6': 'Ceiling Fans & Fixtures',      // Replace Light Fixture (Owner Provided)
  'olit_0c293c5e89ee47c6a761e7751ba992bb': 'Ceiling Fans & Fixtures',      // Replace Recessed Lighting With Slim Downlights
  'olit_60a80f4f44fb48d382bfcb0be0e7ed68': 'Low Voltage',                  // Replace Smoke Detector
  'olit_7bbf7f0eacc44a4e951a56d00b077324': 'Low Voltage',                  // Replace Smoke/ Carbon Monoxide Detector
  'olit_ff5a1da9fa00449e9b190d9ee76f76df': 'Switches, Outlets & Devices',  // Replace Switch / Receptacle
  'olit_3438e149f80d43beb1c86e08e62a567f': 'Underground & Trenching',      // Saw Cut Concrete
  'olit_e1c43c872a8940e08ac366ed8190247e': 'Switches, Outlets & Devices',  // Secure Device In Wall
  'olit_8b773f27fdde40f8a5665293b0989fd8': 'Low Voltage',                  // Security Camera/NVR package
  'olit_4e60cd822ead424e94450b19b7227a19': 'Low Voltage',                  // Smart door bell installation
  'olit_ee668ca6adf647889b84ccc345485bb1': 'Low Voltage',                  // Smart Thermostat Install
  'olit_c083233774e047c688d84d22d2ffb1af': 'New Circuits & Wiring',        // Spa Circuit
  'olit_f69170b7c3104dc9b0d5024ed6f0e0d7': 'New Circuits & Wiring',        // Terminate Existing Appliance
  'olit_d2c0c570b5964275938f26083780523c': 'New Circuits & Wiring',        // Terminate Existing Power Run
  'olit_fa78adfc0fa64d1ca4fd8dc75efd1f7e': 'Fees & Adjustments',           // Travel and Board
  'olit_5f9e23d9068e4575a436caf7d865cbbc': 'Surge Protection',             // Whole Home Surge Protector
  'olit_364340e5192843308f03e412652b079c': 'New Circuits & Wiring',        // Whole Home Energy Monitor
  'pbmat_0667f49f44f4488b986150931ae8ec73': 'Wire & Cable — Materials',    // Boxes, Wire, Devices

  // ── Google category ──────────────────────────────────────────────────────────
  'olit_e3752d42eb334d4f9bbb58516de3384b': 'Ceiling Fans & Fixtures',      // Install Fan
  'olit_426d25a636c549edaf6c84eea5474354': 'Grounding & Bonding',          // Install Ground Wire
  'olit_4c84bd1116284c4bb288ea444bd152e1': 'Ceiling Fans & Fixtures',      // Install Light Fixtures
  'olit_09361873b363496eb781a15e6a93e6b2': 'Ceiling Fans & Fixtures',      // Install Outdoor Lighting
  'olit_8d4a99cf12ba4ef3a5b40a43d495a9b9': 'Switches, Outlets & Devices',  // Install Outlets or Switches
  'olit_ed7d16f165314b489e533b85dbe9548e': 'Low Voltage',                  // Install Security System
  'olit_7fc3bc8c6eaa403f93321023e8d68574': 'EV Charger',                   // Install Electric Car Charger
  'olit_4d26cccc1558496eb3ca6a6f04de177f': 'Fees & Adjustments',           // Other
  'olit_0f3460e5b8b44ad6b0637f7d8de0c53f': 'Remodel — Rough-In',           // Remodeling
  'olit_08334de00b1549f1a9cb5a67770a98fd': 'Switches, Outlets & Devices',  // Relocate Outlets or Switches
  'olit_2aaec523a03c4c32b65d91921c837004': 'Ceiling Fans & Fixtures',      // Repair Fan
  'olit_ab7775fa9c944341a10155b56ce3925d': 'Ceiling Fans & Fixtures',      // Repair Light Fixtures
  'olit_0b9c0452b1c9476aac8623dcba4629fa': 'Switches, Outlets & Devices',  // Repair Outlets or Switches
  'olit_50bbda61b8e2433c8ee1f4e95defdd45': 'Panel Upgrades',               // Repair Panel
  'olit_ebe85bba59f2442a8976666146f1f416': 'Panel Upgrades',               // Replace or Upgrade Panel
  'olit_feed551cd76c405686684d63eb17b0f0': 'Service Calls & Diagnostics',  // Restore Power

  // ── New Build/ Remodel ───────────────────────────────────────────────────────
  'olit_e1f5d86485c247d5acac583eca86d5ee': 'New Circuits & Wiring',        // 15/20a Home Runs
  'olit_66829cdb648843dbadab858fd15cb8fe': 'Switches, Outlets & Devices',  // Remove Aluminum Wiring
  'olit_297549e82347473588b9c551c82b41c3': 'Switches, Outlets & Devices',  // Change 2-Gang to 3-Gang
  'olit_29a6b7d4e2a349eb8d51386fd862c1eb': 'Switches, Outlets & Devices',  // Change Single-Gang to 2-Gang
  'olit_71c533fae0434174812cc03d0c94a759': 'Switches, Outlets & Devices',  // Change Toggle 3-Way
  'olit_4364da0e51f149358089f306049cbb3a': 'Switches, Outlets & Devices',  // Change Toggle 3-Way (11+)
  'olit_8aa93d9d4bda4cbea9e2c5197f2254cf': 'Switches, Outlets & Devices',  // Change Toggle Device (1-10)
  'olit_2890e7151f764159a6b9b24becfd2b83': 'Switches, Outlets & Devices',  // Change Toggle Device (11-40)
  'olit_40ed1c3eb4754756947015d60eba5581': 'Switches, Outlets & Devices',  // Change Toggle Device (41+)
  'olit_2929ad6730524158b9415134b2dc0782': 'Switches, Outlets & Devices',  // Move Receptacle To Countertop
  'olit_95dd131b9fb74565820c510b648db075': 'Remodel — Rough-In',           // Relocate 1-2 Gang Switchbox
  'olit_692901b60bac44f4b6443a182e02fbe7': 'Remodel — Rough-In',           // Relocate 3-4 Gang Switchbox
  'olit_ee0277152fa64535b714b8992d291e80': 'Remodel — Rough-In',           // Relocate Receptacle Box
  'olit_fb23ee63a1624516a39a6e3600feb51e': 'Switches, Outlets & Devices',  // Install 2-Gang Device Cover
  'olit_a39a334128bf4d7cbb7d8dd423735d1f': 'Switches, Outlets & Devices',  // Install 3 Gang Decora Cover
  'olit_050136d1c5cc4f8c95531fa158f8ee75': 'Switches, Outlets & Devices',  // Install 3-Way Switch
  'olit_c7ea49d02ed3494d894c2280e443226b': 'Switches, Outlets & Devices',  // Install 4 Gang Decora Cover
  'olit_257dbe3c42c34b44a641706fb36c98bc': 'Switches, Outlets & Devices',  // Install GFCI
  'olit_eb3830c30db640e0971550229a2b2d22': 'Ceiling Fans & Fixtures',      // Install Switch and Exhaust Fan
  'olit_719fec3bddf34bcb8d0b8e9d91761455': 'Ceiling Fans & Fixtures',      // Install Switch and Fan Rated Box
  'olit_79e2f286a47141a5b7f94eb1798b88ea': 'Ceiling Fans & Fixtures',      // Install Ultra Slim Downlight
  'olit_56178df3f6c24698800ce60a81f646be': 'Ceiling Fans & Fixtures',      // New Switchleg and Cannless Downlights
  'olit_cafe0c2428cc41bd83994a578c03f9e8': 'Ceiling Fans & Fixtures',      // Recenter can light in room
  'olit_94d223ac282a4dceaa4f795fec47f29a': 'Switches, Outlets & Devices',  // Replace Device box
  'olit_d587cbc6dd60457a9498d954af0a6ce2': 'Remodel — Rough-In',           // Residential Rough-in (Per Sq/Ft)
  'olit_1a32ab34f4de4dc7929b01f8af778db2': 'Remodel — Trim-Out',           // Residential Trim-out (Per Sq/Ft)

  // ── Generator Install Items ──────────────────────────────────────────────────
  'olit_1fd6001b351e4bdb9314262d88fc9cc9': 'Generator',
  'olit_8b1275c7cddf4f9393c3a48a67a83d12': 'Generator',
  'olit_7a6f57d9e7304993a29e9775087578fb': 'Generator',

  // ── Ethernet and Data → Low Voltage ─────────────────────────────────────────
  'olit_0de8bdd5115140faa02d62a4c359eec5': 'Low Voltage',

  // ── Wire & Cable ─────────────────────────────────────────────────────────────
  'pbmat_34b7093daa0f4f109455a3ad8fe1b2dc': 'Wire & Cable — Materials',
  'pbmat_df0abb12c20247cd855b9cbe31f6fc75': 'Wire & Cable — Materials',

  // ── Service Upgrades ─────────────────────────────────────────────────────────
  'olit_c4483bf50f3b4d4794f82cbced8adc88': 'Wire & Cable — Materials',     // Install 2/0 SER Service Entrance Cable
  'olit_bf2a10f7534f409899cd491baa4d552e': 'Wire & Cable — Materials',     // Run New Service Cable Wire

  // ── Disconnects ──────────────────────────────────────────────────────────────
  // matched by keyword below (disconnect → Service Entrance)

  // ── Panel/Service (hardware/fittings) ────────────────────────────────────────
  'pbmat_a138a96afe774d8f9b4aa0b00af64910': 'Commercial',                   // 7.5kVA Transformer
  'pbmat_8893cce5478a4b4cb680b01e680139ee': 'Service Entrance',             // Ringless 200A Meter Socket

  // ── Permit and Licensing ─────────────────────────────────────────────────────
  // matched by keyword below

  // ── Tools/ Equipment ─────────────────────────────────────────────────────────
  // These stay as-is — no "Tools & Equipment" in the 19 new cats; use Fees & Adjustments
};

// keyword-based fallback for categories not in UUID_OVERRIDES
function inferCategory(name: string, oldCategory: string): string | null {
  const n = name.toLowerCase();

  // permit / inspection / licensing
  if (/permit|inspection fee|license/.test(n) || oldCategory === 'Permit and Licensing') {
    return 'Permits & Inspections';
  }
  // generator
  if (/generator|solar|battery pack|transfer switch|ats\b/.test(n) ||
      oldCategory === 'Generator Equipment' || oldCategory === 'Generator Install Items') {
    return 'Generator';
  }
  // ev charger
  if (/\bev\b|electric vehicle|electric car|level 2|car charger/.test(n)) {
    return 'EV Charger';
  }
  // surge
  if (/surge/.test(n)) return 'Surge Protection';
  // grounding / bonding
  if (/ground(ing)?|bond(ing)?|ground rod/.test(n)) return 'Grounding & Bonding';
  // low voltage / data / cameras
  if (/ethernet|cat5|cat6|cat8|data|network switch|alarm|camera|security system|doorbell|intercom|tv back|hdmi|flat panel tv|smoke detector|carbon monoxide|co detector|thermostat|ring cam|nvr|jack plate|rj-45/.test(n)) {
    return 'Low Voltage';
  }
  // conduit materials
  if (oldCategory === 'Panel/Service' && /nipple|locknut|closure|fitting|hub|conduit/.test(n)) {
    return 'Conduit — Materials';
  }
  // panel/service hardware that is a panel component
  if (oldCategory === 'Panel/Service' && /loadcenter|panel|meter socket|transformer|surface cover/.test(n)) {
    return 'Panel Upgrades';
  }
  // service entrance / disconnects
  if (/disconnect|meter base|meter enclosure|meter socket|service entrance|overhead service|underground service|riser|slip joint/.test(n) ||
      oldCategory === 'Disconnects' || oldCategory === 'Service Upgrades') {
    return 'Service Entrance';
  }
  // panel upgrades
  if (/\bpanel\b|breaker|load center|subpanel|sub panel|interlock/.test(n)) return 'Panel Upgrades';
  // underground / trenching / saw cut
  if (/trench|underground|saw cut|bore/.test(n)) return 'Underground & Trenching';
  // conduit install (labor)
  if (/conduit/.test(n)) return 'Conduit — Materials';
  // wire/cable materials
  if (oldCategory === 'Wire & Cable' || /\bser\b.*cable|thhn|romex|aluminum.*wire|wire.*material/.test(n)) {
    return 'Wire & Cable — Materials';
  }
  // ceiling fans & fixtures
  if (/fan|fixture|chandelier|sconce|pendant|\blight\b|led|can light|recessed|downlight|slim can|bulb|exhaust fan|bathroom fan|pool light|landscape light|fence light|flood|string light|area light|wall pack|vaportite|ballast/.test(n)) {
    return 'Ceiling Fans & Fixtures';
  }
  // switches / outlets / devices
  if (/receptacle|outlet|gfci|afci|switch|dimmer|plug|socket|decora|toggle|device|cover plate|gang box|pigtail/.test(n)) {
    return 'Switches, Outlets & Devices';
  }
  // new circuits / wiring
  if (/circuit|home run|run wire|pull wire|wire run|dryer|spa|appliance|mini split|energy monitor|power run/.test(n)) {
    return 'New Circuits & Wiring';
  }
  // remodel rough-in / trim-out
  if (/rough.?in/.test(n)) return 'Remodel — Rough-In';
  if (/trim.?out/.test(n)) return 'Remodel — Trim-Out';
  // service calls
  if (/service call|troubleshoot|job walk|make safe|restore power|repair/.test(n)) {
    return 'Service Calls & Diagnostics';
  }
  // commercial
  if (/commercial|wap|ct meter|nema 4x|enclosure/.test(n)) return 'Commercial';
  // fees / adjustments
  if (/gratuity|tip|discount|credit|adjustment|travel|board|sheetrock|custom job/.test(n)) {
    return 'Fees & Adjustments';
  }
  // tools / equipment → Fees & Adjustments (no Tools cat in the 19)
  if (oldCategory === 'Tools/ Equipment') return 'Fees & Adjustments';
  // outdoor devices category
  if (oldCategory === 'Outdoor Devices') {
    if (/camera|ring/.test(n)) return 'Low Voltage';
    if (/light|step light|deck|fence/.test(n)) return 'Ceiling Fans & Fixtures';
    if (/transformer/.test(n)) return 'Ceiling Fans & Fixtures';
    return 'Switches, Outlets & Devices';
  }
  // fixtures category
  if (oldCategory === 'Fixtures') return 'Ceiling Fans & Fixtures';
  // security cameras
  if (oldCategory === 'Security Camera Systems') return 'Low Voltage';
  // ethernet and data
  if (oldCategory === 'Ethernet and Data') return 'Low Voltage';
  // new build remodel
  if (oldCategory === 'New Build/ Remodel') {
    if (/rough.?in/.test(n)) return 'Remodel — Rough-In';
    if (/trim.?out/.test(n)) return 'Remodel — Trim-Out';
    if (/home run|circuit/.test(n)) return 'New Circuits & Wiring';
    if (/can light|downlight|slim|switchleg/.test(n)) return 'Ceiling Fans & Fixtures';
    return 'Switches, Outlets & Devices';
  }
  // google category
  if (oldCategory === 'Google') {
    if (/fan/.test(n)) return 'Ceiling Fans & Fixtures';
    if (/light/.test(n)) return 'Ceiling Fans & Fixtures';
    if (/panel/.test(n)) return 'Panel Upgrades';
    if (/outlet|switch/.test(n)) return 'Switches, Outlets & Devices';
    if (/security|camera/.test(n)) return 'Low Voltage';
    if (/car charger|ev/.test(n)) return 'EV Charger';
    if (/remodel/.test(n)) return 'Remodel — Rough-In';
    if (/other/.test(n)) return 'Fees & Adjustments';
    if (/ground/.test(n)) return 'Grounding & Bonding';
    if (/power/.test(n)) return 'Service Calls & Diagnostics';
  }
  // miscellaneous material
  if (oldCategory === 'Miscellaneous Material') return 'Fees & Adjustments';

  return null;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = ''; let inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

function escapeCsv(s: string): string { return `"${s.replace(/"/g, '""')}"` ; }

async function main() {
  const raw = await fs.readFile(CSV_PATH, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const header = lines[0];

  let moved = 0;
  let skipped = 0;
  let alreadyNew = 0;

  const newBody = lines.slice(1).map(line => {
    const cols = parseCsvLine(line);
    if (cols.length < 5) return line;

    const oldCat = cols[2].trim();
    const uuid = cols[3].trim();
    const name = cols[4].trim();

    // Already in a new category — skip
    if (NEW_CATS.has(oldCat)) { alreadyNew++; return line; }

    // UUID override takes precedence
    let newCat: string | null = UUID_OVERRIDES[uuid] ?? null;

    // Fallback to keyword inference
    if (!newCat) newCat = inferCategory(name, oldCat);

    if (!newCat) {
      console.log(`  UNRESOLVED: [${oldCat}] ${name} (${uuid})`);
      skipped++;
      return line;
    }

    if (!APPLY) {
      console.log(`  "${oldCat}" → "${newCat}" | ${name}`);
    }

    cols[2] = newCat;
    moved++;
    return cols.map(escapeCsv).join(',');
  });

  console.log(`\nSummary:`);
  console.log(`  Remapped: ${moved}`);
  console.log(`  Already in new category: ${alreadyNew}`);
  console.log(`  Unresolved (left unchanged): ${skipped}`);

  if (APPLY) {
    await fs.writeFile(CSV_PATH, [header, ...newBody].join('\n'), 'utf-8');
    console.log(`\n✅ Applied ${moved} category remaps to pricebook.csv`);
    if (skipped > 0) console.log(`⚠️  ${skipped} items still need manual assignment.`);
  } else {
    console.log('\nDry run only. Pass --apply to write changes.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
