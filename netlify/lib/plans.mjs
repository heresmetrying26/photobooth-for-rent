import {
  newCode, displayCode, normCode, DAY, MIN, LIFETIME_EXP, MAX_DEVICES, BONUS_SUBFOLDER,
  putLicense, sendMail, codeEmail, EMAIL_RE
} from './core.mjs';

export const ALL_PLANS = {
  // Monthly Subscriptions (30 days from first unlock)
  online: {
    id: 'online',
    title: 'Monthly Online',
    category: 'monthly',
    price: 799,
    priceStr: '₱799 / month',
    description: 'iPad, tablet or laptop browser · online · unlimited events',
    days: 30,
    lifetime: false,
    devices: 1,
    traditional: true,
    offlineOpt: false,
    offlineOnly: false
  },
  offline: {
    id: 'offline',
    title: 'Monthly Offline (Laptop + Android)',
    category: 'monthly',
    price: 999,
    priceStr: '₱999 / month',
    description: 'Windows / Mac + Android tablet offline apps · zero internet needed',
    days: 30,
    lifetime: false,
    devices: 1,
    traditional: true,
    offlineOpt: true,
    offlineOnly: true
  },
  both: {
    id: 'both',
    title: 'Monthly Online + Offline',
    category: 'monthly',
    price: 1399,
    priceStr: '₱1,399 / month',
    description: 'Both: online booth & offline desktop app',
    days: 30,
    lifetime: false,
    devices: 1,
    traditional: true,
    offlineOpt: true,
    offlineOnly: false
  },

  // Per Event Packages (24 hours on event date + 1-hour practice code)
  tablet: {
    id: 'tablet',
    title: 'Tablet Booth (Per Event)',
    category: 'event',
    price: 499,
    priceStr: '₱499 / event',
    description: 'iPad or Android tablet · online · includes 1-hr practice code',
    days: 1,
    lifetime: false,
    devices: 1,
    traditional: false,
    offlineOpt: false,
    offlineOnly: false,
    bonusMinutes: 60
  },
  laptop: {
    id: 'laptop',
    title: 'Event Pass (Per Event)',
    category: 'event',
    price: 599,
    priceStr: '₱599 / event',
    description: 'One event, tablet or laptop · guest screen, auto-print · online or offline app · includes 1-hr practice code',
    days: 1,
    lifetime: false,
    devices: 1,
    traditional: true,
    offlineOpt: true,
    offlineOnly: false,
    bonusMinutes: 60
  },

  // Lifetime Packages (Never expires, 5 devices)
  lifeonline: {
    id: 'lifeonline',
    title: 'Lifetime Online',
    category: 'lifetime',
    price: 2999,
    priceStr: '₱2,999 one-time',
    description: 'Tablet or laptop in the browser · every event · never expires · 5 devices',
    days: 1,
    lifetime: true,
    devices: 5,
    traditional: true,
    offlineOpt: false,
    offlineOnly: false
  },
  lifeoffline: {
    id: 'lifeoffline',
    title: 'Lifetime Offline',
    category: 'lifetime',
    price: 3499,
    priceStr: '₱3,499 one-time',
    description: 'The Windows / Mac app, works with no internet · every event · never expires · 5 devices',
    days: 1,
    lifetime: true,
    devices: 5,
    traditional: true,
    offlineOpt: true,
    offlineOnly: true
  },
  lifetime: {
    id: 'lifetime',
    title: 'Lifetime Online + Offline',
    category: 'lifetime',
    price: 4999,
    priceStr: '₱4,999 one-time',
    description: 'Both: online booth & offline Windows / Mac app · never expires · 5 devices',
    days: 1,
    lifetime: true,
    devices: 5,
    traditional: true,
    offlineOpt: true,
    offlineOnly: false
  },

  // Add-ons for existing Lifetime owners
  addon_offline: {
    id: 'addon_offline',
    title: 'Add Offline App Later',
    category: 'addon',
    price: 2499,
    priceStr: '₱2,499 one-time',
    description: 'For Lifetime Online owners: unlocks Windows / Mac app',
    traditional: true,
    offlineOpt: true,
    offlineOnly: false
  },
  addon_online: {
    id: 'addon_online',
    title: 'Add Online Booth Later',
    category: 'addon',
    price: 1999,
    priceStr: '₱1,999 one-time',
    description: 'For Lifetime Offline owners: unlocks online booth & My Events',
    traditional: true,
    offlineOpt: true,
    offlineOnly: false
  }
};

export function getPlanDeliverables(planKey, code, practiceCode) {
  const p = ALL_PLANS[planKey] || ALL_PLANS.online;
  const isOffline = !!p.offlineOpt;
  const isOnline = !p.offlineOnly;

  const files = [];
  const links = [];

  if (isOnline) {
    files.push({
      id: 'setup-guide',
      name: 'Setup Guide (PDF)',
      url: '/lifetime/photobooth4u-setup-guide.pdf',
      badge: 'PDF Guide',
      desc: 'Step-by-step camera, lighting, gallery, printing & sharing setup'
    });
    if (p.id === 'tablet') {
      files.push({
        id: 'tablet-guide',
        name: 'Tablet Guide (PDF)',
        url: '/lifetime/photobooth4u-tablet-guide.pdf',
        badge: 'PDF Guide',
        desc: 'Quick iPad and Android tablet setup instructions'
      });
    }
    links.push({
      id: 'launch-booth',
      name: 'Launch Online Booth',
      url: code ? `/?code=${encodeURIComponent(code)}` : '/',
      desc: 'Open the booth in your browser with your access code pre-filled'
    });
    links.push({
      id: 'my-events',
      name: 'My Events Portal',
      url: code ? `/lifetime/#${encodeURIComponent(code)}` : '/lifetime/',
      desc: 'Manage your events, guest galleries, guest payments and Drive photos'
    });
  }

  if (isOffline) {
    files.push({
      id: 'offline-guide',
      name: 'Offline App Guide (PDF)',
      url: '/lifetime/photobooth4u-offline-app-guide.pdf',
      badge: 'PDF Guide',
      desc: 'App installation, code activation, DSLR over USB & offline Wi-Fi guest sharing'
    });
    files.push({
      id: 'hiti-guide',
      name: 'Hiti / Photo Printer Guide (PDF)',
      url: '/lifetime/photobooth4u-hiti-printing-guide.pdf',
      badge: 'PDF Guide',
      desc: 'Fast auto-printing setup for Hiti, DNP, Canon Selphy & thermal printers'
    });
    links.push({
      id: 'app-downloads',
      name: 'Offline App Downloads',
      url: code ? `/app/#${encodeURIComponent(code)}` : '/app/',
      desc: 'Download desktop app for Windows 10/11 (.exe), Mac Apple Silicon (.dmg) or Mac Intel (.dmg)'
    });
    links.push({
      id: 'dnp-guide',
      name: 'DNP Photo Printer Guide',
      url: '/how-to-print-dnp/',
      desc: 'Step-by-step setup for DNP RX1HS, DS620, DS40 with 2×6 strip auto-cut'
    });
  }

  return { files, links };
}

async function freshKey(store) {
  let key;
  do { key = newCode(); } while (await store.get(key));
  return key;
}

export async function fulfillPlanPayment({ store, planKey, name, email, renewCode, now, origin }) {
  now = now || Date.now();
  const planCfg = ALL_PLANS[planKey] || ALL_PLANS.online;
  let code = null;
  let practiceCode = null;
  let renewed = false;
  let mainRec = null;

  // Renew / Upgrade existing code if provided
  if (renewCode) {
    const key = normCode(renewCode);
    const existing = key ? await store.get(key, { type: 'json' }) : null;
    if (existing && existing.kind !== 'bonus') {
      if (planCfg.category === 'addon') {
        if (planCfg.id === 'addon_offline') {
          existing.offlineOpt = true;
          existing.offlineOnly = false;
        } else if (planCfg.id === 'addon_online') {
          existing.offlineOnly = false;
        }
      } else if (planCfg.category === 'lifetime') {
        existing.lifetime = true;
        existing.maxDevices = Math.max(existing.maxDevices || 1, 5);
        if (existing.status === 'active') existing.expiresAt = LIFETIME_EXP;
        if (planCfg.offlineOpt) existing.offlineOpt = true;
        if (planCfg.offlineOnly) existing.offlineOnly = true;
        if (!planCfg.offlineOnly) existing.offlineOnly = false;
      } else if (planCfg.category === 'monthly') {
        existing.expiresAt = Math.max(existing.expiresAt || 0, now) + 30 * DAY;
        existing.status = 'active';
        if (planCfg.offlineOpt) existing.offlineOpt = true;
        if (planCfg.offlineOnly) existing.offlineOnly = true;
        if (!planCfg.offlineOnly) existing.offlineOnly = false;
      }
      // Always ensure the booth feature switches are on after any renewal/upgrade
      existing.retakeOpt = true;
      existing.payOpt = true;
      existing.lockOpt = true;
      existing.gifOpt = true;
      try {
        await putLicense(store, existing.key, existing);
      } catch {
        await store.setJSON(existing.key, existing);
      }
      code = existing.code;
      mainRec = existing;
      renewed = true;
    }
  }

  // Provision new code
  if (!code) {
    const key = await freshKey(store);
    const cleanLabel = (name || '').trim().slice(0, 80);
    const label = cleanLabel ? `${cleanLabel} · ${planCfg.title}` : `${planCfg.title} · ${displayCode(key)}`;
    const folderName = cleanLabel ? `${cleanLabel} · ${displayCode(key)}` : displayCode(key);

    mainRec = {
      key,
      code: displayCode(key),
      kind: 'rental',
      label,
      folderName,
      days: planCfg.days || 1,
      lifetime: !!planCfg.lifetime,
      maxDevices: planCfg.devices || 1,
      defaultTheme: null,
      startsAt: null, // Begins counting upon first redemption on device
      print: { enabled: true, sizes: ['2x6', '4x6'], eventLimit: 0, sessionLimit: 0 },
      traditional: planCfg.traditional !== false,
      gifOpt: true,
      offlineOpt: !!planCfg.offlineOpt,
      offlineOnly: !!planCfg.offlineOnly,
      // Automatically enable all booth feature switches for every paid plan:
      retakeOpt: true,   // Give retake switch
      payOpt: true,      // Guest payment (vouchers / PayMongo)
      lockOpt: true,     // Lock booth with PIN
      status: 'unused',
      createdAt: now,
      redeemedAt: null,
      expiresAt: null,
      deviceId: null,
      email: email || null
    };

    // If per-event plan, provision a 1-hour practice code
    if (planCfg.bonusMinutes) {
      const bKey = await freshKey(store);
      const bonus = {
        key: bKey,
        code: displayCode(bKey),
        kind: 'bonus',
        parent: key,
        label: `${label} · 1-Hr Practice`,
        folderName,
        subfolder: 'practice',
        minutes: planCfg.bonusMinutes,
        days: 0,
        startsAt: null,
        print: mainRec.print,
        traditional: mainRec.traditional,
        gifOpt: true,
        offlineOpt: mainRec.offlineOpt,
        offlineOnly: mainRec.offlineOnly,
        status: 'unused',
        createdAt: now + 1,
        redeemedAt: null,
        expiresAt: null,
        deviceId: null
      };
      mainRec.bonusKey = bKey;
      practiceCode = bonus.code;
      try {
        await putLicense(store, bKey, bonus);
      } catch {
        await store.setJSON(bKey, bonus);
      }
    }

    try {
      await putLicense(store, key, mainRec);
    } catch {
      await store.setJSON(key, mainRec);
    }
    code = mainRec.code;
    renewed = false;

    // Send confirmation email if email relay is active
    if (email && origin) {
      try {
        const mail = codeEmail([mainRec], origin);
        await sendMail({ to: email, ...mail });
      } catch (err) {
        console.warn('Payment email notice error (non-fatal):', err.message);
      }
    }
  }

  const deliverables = getPlanDeliverables(planCfg.id, code, practiceCode);

  return {
    code,
    practiceCode,
    plan: planCfg,
    renewed,
    files: deliverables.files,
    links: deliverables.links
  };
}
