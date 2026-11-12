// api/cron.js
// Daily tracking and post-purchase transactional email cron (Days 0 to 8).
// Zero date bug: never resets or overwrites past order dates.
// Operates strictly in Africa/Johannesburg timezone (SAST, UTC+2).
// Idempotent: 1 email per order per day (checked via last_daily_email_date).
//
// Trigger:
//   - Scheduled: Vercel Cron daily at 08:00 UTC (10:00 SAST)
//   - Manual test: GET /api/cron
//   - Force test:  GET /api/cron?force=1
//   - Single order test: GET /api/cron?order=T...&force=1

'use strict';

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL
  || process.env.UPSTASH_REDIS_REST_URL
  || process.env.KV_REST_API_URL
  || 'https://chief-crab-198297.upstash.io';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
  || process.env.UPSTASH_REDIS_REST_TOKEN
  || process.env.KV_REST_API_TOKEN
  || process.env.REDIS_TOKEN
  || 'gQAAAAAAAwaZAAIgcDI4ZmM0NzUwNzk2ZWQ0N2JiODJmOGY4MGQ3ZDU3YjJiMg';

const VISIONSPY_KEY = process.env.VISIONSPY_API_KEY
  || process.env.VISION_SPY_API_KEY
  || process.env.VISIONSPY_KEY
  || 'vs_live_5623f17b36bdf353ba179aa6ed606e1935c6aa4ac4b1aea5';
const VISIONSPY_SENDER_ID = process.env.VISIONSPY_SENDER_ID || 'd86d0b35-3472-4aac-af74-4bd52308ea07';

const fs = require('fs');
const path = require('path');

const TIMEZONE = 'Africa/Johannesburg';

// ── Date Helpers (Africa/Johannesburg SAST, UTC+2) ─────────────────────────────
function getSADateIso(dateInput) {
  if (!dateInput) return null;
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function calculateSADaysElapsed(receivedDateInput, nowInput = new Date()) {
  const pIso = getSADateIso(receivedDateInput);
  const nowIso = getSADateIso(nowInput);
  if (!pIso || !nowIso) return 0;
  const [py, pm, pd] = pIso.split('-').map(Number);
  const [ny, nm, nd] = nowIso.split('-').map(Number);
  const diff = Math.floor((Date.UTC(ny, nm - 1, nd) - Date.UTC(py, pm - 1, pd)) / 86400000);
  return diff < 0 ? 0 : diff;
}

function formatOrderDateShort(dateVal) {
  const d = typeof dateVal === 'string' || typeof dateVal === 'number' ? new Date(dateVal) : dateVal;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

function formatDeliveryDateLong(dateVal) {
  const d = typeof dateVal === 'string' || typeof dateVal === 'number' ? new Date(dateVal) : dateVal;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

function formatDeliveryDateShort(dateVal) {
  const d = typeof dateVal === 'string' || typeof dateVal === 'number' ? new Date(dateVal) : dateVal;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

// ── Redis Upstash REST helpers ─────────────────────────────────────────────────
async function kv_get(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['GET', key]),
  });
  if (!res.ok) throw new Error('Redis GET failed: ' + res.status);
  const data = await res.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function kv_set(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SET', key, JSON.stringify(value)]),
  });
  if (!res.ok) throw new Error('Redis SET failed: ' + res.status);
  return true;
}

// ── 8-Day Lifecycle Stages ─────────────────────────────────────────────────────
const STAGES = {
  1: {
    stage: 1,
    status: 'IN_TRANSIT',
    subject: (id) => `Order Update: #${id} is Packed & Ready for Dispatch 📦`,
    headline: 'Order Packed & Ready for Dispatch',
    paragraphs: (id, delLong) => [
      `Great news! Your order <strong>${id}</strong> has been picked, quality checked, and carefully packed at our warehouse.`,
      `It is now queued for dispatch with our courier partner. Your scheduled delivery date is <strong>${delLong}</strong>.`,
      `We'll send you another tracking update as soon as the driver scans your package into the delivery vehicle.`,
    ],
  },
  2: {
    stage: 2,
    status: 'IN_TRANSIT',
    markShipped: true,
    subject: (id) => `Your Order #${id} Has Shipped! 🚚`,
    headline: 'Your Order Has Shipped',
    paragraphs: (id, delLong) => [
      `Your parcel has officially departed our fulfillment center and is on its way via courier delivery.`,
      `Scheduled delivery remains on track for <strong>${delLong}</strong>.`,
      `You can track the live progress and delivery updates anytime using the link below.`,
    ],
  },
  3: {
    stage: 3,
    status: 'IN_TRANSIT',
    subject: (id) => `In Transit: Order #${id} is on Route to Regional Hub 🚛`,
    headline: 'In Transit to Regional Hub',
    paragraphs: (id, delLong) => [
      `Your order <strong>${id}</strong> is in transit between our primary distribution centers, on route to your regional distribution hub.`,
      `Estimated courier delivery date: <strong>${delLong}</strong>.`,
      `Our logistics team is monitoring your parcel for a smooth and timely handover.`,
    ],
  },
  4: {
    stage: 4,
    status: 'IN_TRANSIT',
    subject: (id) => `Transit Update: Order #${id} Arrived at Regional Hub 🏢`,
    headline: 'Arrived at Regional Hub',
    paragraphs: (id, delLong) => [
      `Your shipment for order <strong>${id}</strong> has safely arrived at the regional hub facility.`,
      `It is undergoing local intake and will move to automated sorting shortly. Scheduled delivery is confirmed for <strong>${delLong}</strong>.`,
    ],
  },
  5: {
    stage: 5,
    status: 'IN_TRANSIT',
    subject: (id) => `Tracking Update: Order #${id} Cleared Sorting Facility 📋`,
    headline: 'Cleared Sorting Facility',
    paragraphs: (id, delLong) => [
      `Your parcel has cleared the automated sorting facility and has been allocated to your area's delivery branch.`,
      `Estimated delivery date: <strong>${delLong}</strong>.`,
    ],
  },
  6: {
    stage: 6,
    status: 'IN_TRANSIT',
    subject: (id) => `Almost There: Order #${id} Arrived at Local Depôt 📍`,
    headline: 'Arrived at Local Depôt',
    paragraphs: (id, delLong) => [
      `Your package is now at the local delivery depôt closest to your delivery address.`,
      `Final dispatch preparation and vehicle assignment are now in progress. Your order is scheduled for delivery on <strong>${delLong}</strong>.`,
    ],
  },
  7: {
    stage: 7,
    status: 'OUT_FOR_DELIVERY',
    subject: (id) => `Scheduled for Tomorrow: Order #${id} ⏰`,
    headline: 'Scheduled for Delivery Tomorrow',
    paragraphs: (id, delLong) => [
      `Get ready! Your order <strong>${id}</strong> is scheduled for courier delivery tomorrow (<strong>${delLong}</strong>).`,
      `Please ensure someone is available at your delivery address to receive the parcel. You will receive an SMS notification confirming your delivery window.`,
    ],
  },
  8: {
    stage: 8,
    status: 'DELIVERED',
    markDelivered: true,
    subject: (id) => `Delivered: Your Order #${id} 📦`,
    headline: 'Your Order Has Been Delivered',
    paragraphs: (id) => [
      `Your Takealot order <strong>${id}</strong> has been successfully delivered!`,
      `We hope you enjoy your new PlayStation 5 Digital Edition + Dualsense 5 Controller + PS VR2 + GTA 6 + FC27 + Black Myth: Wukong - PS5.`,
      `If you have any questions or feedback about your delivery, our support team is always here to assist.`,
    ],
  },
};

// ── Email Template Loader & Renderers ──────────────────────────────────────────
function loadBaseEmailTemplate() {
  const candidatePaths = [
    path.join(process.cwd(), 'email.index'),
    path.join(__dirname, '..', 'email.index'),
    path.join(__dirname, 'email.index'),
    path.resolve('email.index'),
  ];
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const c = fs.readFileSync(p, 'utf8');
        if (c) return c;
      }
    } catch (_) {}
  }
  return null;
}

function renderStageHtml(template, order, stageInfo, pDate, dDate) {
  const customerName = order.customer_name || 'Customer';
  const orderNumber = order.order_id;
  const orderDateShort = formatOrderDateShort(pDate);
  const deliveryDateShort = formatDeliveryDateShort(dDate);
  const deliveryDateLong = formatDeliveryDateLong(dDate);

  let html = template
    .replace(/\{\{customer_name\}\}/g, customerName)
    .replace(/\{\{order_number\}\}/g, orderNumber)
    .replace(/\{\{order_date\}\}/g, orderDateShort)
    .replace(/\{\{delivery_date\}\}/g, deliveryDateShort)
    .replace(/\{\{delivery_date_long\}\}/g, deliveryDateLong)
    .replace(/\{\{variant\}\}/g, 'White / Black');

  // Replace header title if needed
  if (stageInfo && stageInfo.headline) {
    html = html.replace(/Takealot Payment Confirmation/g, `Takealot &middot; ${stageInfo.headline}`);
    html = html.replace(/Payment Confirmation/g, stageInfo.headline);
  }

  // Inject stage-specific paragraphs
  if (stageInfo && stageInfo.paragraphs) {
    const stageParagraphs = stageInfo.paragraphs(orderNumber, deliveryDateLong);
    const customBody = stageParagraphs
      .map((p) => `<p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">${p}</p>`)
      .join('\n');

    // Replace the default static confirmation body paragraphs
    const pattern = /Thank you, we've received your payment[\s\S]*?scheduled delivery date\./;
    if (pattern.test(html)) {
      html = html.replace(pattern, stageParagraphs.join(' '));
    }
  }

  return html;
}

function renderStagePlainText(order, stageInfo, pDate, dDate) {
  const customerName = order.customer_name || 'Customer';
  const orderNumber = order.order_id;
  const orderDateShort = formatOrderDateShort(pDate);
  const deliveryDateLong = formatDeliveryDateLong(dDate);
  const trackUrl = `https://takekalotpromips.vercel.app/track.html?order=${encodeURIComponent(orderNumber)}`;

  const paragraphs = stageInfo.paragraphs(orderNumber, deliveryDateLong)
    .map((p) => p.replace(/<[^>]+>/g, ''));

  return [
    `TAKEALOT ORDER UPDATE - ${stageInfo.headline.toUpperCase()}`,
    `Order Number: ${orderNumber}`,
    `Estimated Delivery Date: ${deliveryDateLong}`,
    ``,
    `Hi ${customerName},`,
    ``,
    ...paragraphs,
    ``,
    `TRACK YOUR ORDER:`,
    `${trackUrl}`,
    ``,
    `ORDER DETAILS:`,
    `- Order Date: ${orderDateShort}`,
    `- Estimated Delivery Date: ${deliveryDateLong}`,
    `- Delivery Method: Courier`,
    `- Item: 1x PlayStation 5 Digital Edition + Dualsense 5 Controller + PS VR2 + GTA 6 + FC27 + Black Myth: Wukong - PS5 - R 2,597.00`,
    `- Total Paid: R 2,597.00`,
    ``,
    `Need help? Visit https://takekalotpromips.vercel.app`,
    ``,
    `Regards,`,
    `The Takealot Team`,
    ``,
    `----------------------------------------------------------------------`,
    `Takealot Online (Pty) Ltd • Reg. No. 2010/020248/07 • VAT No. 4440256861`,
    `12 Rua Vasco Da Gama, Foreshore, Cape Town, 8001, South Africa`,
  ].join('\n');
}

// ── VisionSpy Sender ───────────────────────────────────────────────────────────
async function sendVisionSpyEmail(to, subject, html, text) {
  const res = await fetch('https://visionspyads.com/api/public/v1/email/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VISIONSPY_KEY.trim()}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Takealot-Order-Notification/1.0',
    },
    body: JSON.stringify({
      sender_id: VISIONSPY_SENDER_ID,
      to,
      subject,
      html,
      text,
    }),
  });
  const data = await res.json().catch(() => null);
  const ok = res.ok && data && (data.ok !== false && data.success !== false);
  return { ok, status: res.status, data };
}

// ── Process Single Order ───────────────────────────────────────────────────────
async function processOrderDailyEmail(order, options = {}) {
  const { force = false, stageOverride = null, template = null } = options;
  const orderId = order.order_id;
  const email = (order.customer_email || '').trim();

  if (!email || !email.includes('@')) {
    return { order_id: orderId, action: 'SKIPPED_NO_EMAIL' };
  }

  // 1. Immutable purchase date
  const pDate = new Date(order.received_date || order.created_at || Date.now());
  if (isNaN(pDate.getTime())) {
    return { order_id: orderId, action: 'SKIPPED_INVALID_DATE' };
  }

  // 2. Ensure delivery_date exists strictly 8 calendar days from purchase
  if (!order.delivery_date) {
    order.delivery_date = new Date(pDate.getTime() + 8 * 86400000).toISOString();
    await kv_set('order:' + orderId, order).catch(() => {});
  }
  const dDate = new Date(order.delivery_date);

  // 3. Exact days elapsed in Africa/Johannesburg (zero date bug)
  const daysElapsed = stageOverride !== null ? stageOverride : calculateSADaysElapsed(pDate);
  const todaySA = getSADateIso(new Date());

  // Day 0: Confirmation email sent at purchase time. Cron skips day 0.
  if (daysElapsed === 0) {
    return {
      order_id: orderId,
      days_elapsed: 0,
      today: todaySA,
      action: 'SKIPPED_DAY_ZERO',
      note: 'Day 0 is handled on order creation / checkout',
    };
  }

  // Day 9+: Already delivered, cycle completed
  if (daysElapsed >= 9) {
    if (order.status !== 'DELIVERED') {
      order.status = 'DELIVERED';
      order.email_delivered_status = 'SENT';
      await kv_set('order:' + orderId, order).catch(() => {});
    }
    return {
      order_id: orderId,
      days_elapsed: daysElapsed,
      today: todaySA,
      action: 'ALREADY_DELIVERED',
    };
  }

  // Days 1 through 8: Stage email
  const stageInfo = STAGES[daysElapsed];
  if (!stageInfo) {
    return { order_id: orderId, days_elapsed: daysElapsed, action: 'UNKNOWN_STAGE' };
  }

  // 4. Idempotency check: 1 email per day unless forced
  if (!force && order.last_daily_email_date === todaySA) {
    return {
      order_id: orderId,
      stage: daysElapsed,
      days_elapsed: daysElapsed,
      today: todaySA,
      action: 'ALREADY_SENT_TODAY',
      last_sent: order.last_daily_email_date,
    };
  }

  // 5. Render email
  const baseTpl = template || loadBaseEmailTemplate() || '';
  const subject = stageInfo.subject(orderId);
  const html = renderStageHtml(baseTpl, order, stageInfo, pDate, dDate);
  const plainText = renderStagePlainText(order, stageInfo, pDate, dDate);

  // 6. Send via VisionSpy API
  const sendRes = await sendVisionSpyEmail(email, subject, html, plainText);
  if (!sendRes.ok) {
    console.error(`[cron] Failed to send stage ${daysElapsed} to ${email} (Order ${orderId}):`, sendRes.data);
    return {
      order_id: orderId,
      stage: daysElapsed,
      action: 'FAILED_SEND',
      error: sendRes.data,
    };
  }

  // 7. Update order state idempotently
  order.last_daily_email_date = todaySA;
  order.status = stageInfo.status;
  if (stageInfo.markShipped) {
    order.email_shipped_status = 'SENT';
  }
  if (stageInfo.markDelivered) {
    order.email_delivered_status = 'SENT';
  }

  if (!Array.isArray(order.daily_emails_sent)) {
    order.daily_emails_sent = [];
  }
  order.daily_emails_sent.push({
    stage: daysElapsed,
    date: todaySA,
    sent_at: new Date().toISOString(),
    subject,
    message_id: (sendRes.data && sendRes.data.id) || null,
  });

  await kv_set('order:' + orderId, order).catch(() => {});
  console.log(`[cron] Successfully sent stage ${daysElapsed} (${stageInfo.headline}) to ${email} for order ${orderId}`);

  return {
    order_id: orderId,
    stage: daysElapsed,
    stage_name: stageInfo.headline,
    recipient: email.replace(/(.{2}).*(@.*)/, '$1***$2'),
    action: `SENT_STAGE_${daysElapsed}`,
    date: todaySA,
    message_id: (sendRes.data && sendRes.data.id) || null,
  };
}

// ── Vercel Serverless Handler ──────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const startTime = Date.now();
  const force = req.query.force === '1' || req.query.force === 'true';
  const targetOrderId = (req.query.order || req.query.id || '').trim();
  const stageOverride = req.query.stage !== undefined ? parseInt(req.query.stage, 10) : null;
  const todaySA = getSADateIso(new Date());

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'Redis environment variables not configured' });
  }

  const template = loadBaseEmailTemplate() || '';

  try {
    let ordersToProcess = [];

    if (targetOrderId) {
      let single = await kv_get('order:' + targetOrderId);
      if (!single) {
        if (req.query.to || req.query.email) {
          single = {
            order_id: targetOrderId,
            customer_name: (req.query.name || 'Customer').trim(),
            customer_email: (req.query.to || req.query.email).trim(),
            received_date: req.query.date || req.query.received_date || new Date().toISOString(),
          };
        } else {
          return res.status(404).json({ error: `Order #${targetOrderId} not found in database` });
        }
      }
      ordersToProcess = [single];
    } else {
      const resKeys = await fetch(REDIS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['KEYS', 'order:*']),
      });
      const dataKeys = await resKeys.json();
      const keys = Array.isArray(dataKeys.result) ? dataKeys.result : [];

      for (const k of keys) {
        try {
          const ord = await kv_get(k);
          if (ord && ord.order_id) {
            ordersToProcess.push(ord);
          }
        } catch (_) {}
      }
    }

    const results = [];
    for (const ord of ordersToProcess) {
      try {
        const r = await processOrderDailyEmail(ord, { force, stageOverride, template });
        results.push(r);
      } catch (err) {
        results.push({ order_id: ord.order_id, action: 'ERROR', error: err.message });
      }
    }

    const summary = {
      ok: true,
      today_sa: todaySA,
      total_orders_evaluated: ordersToProcess.length,
      sent_count: results.filter((r) => r.action && r.action.startsWith('SENT_STAGE_')).length,
      already_sent_today: results.filter((r) => r.action === 'ALREADY_SENT_TODAY').length,
      skipped_day_zero: results.filter((r) => r.action === 'SKIPPED_DAY_ZERO').length,
      already_delivered: results.filter((r) => r.action === 'ALREADY_DELIVERED').length,
      elapsed_ms: Date.now() - startTime,
      results,
    };

    return res.status(200).json(summary);
  } catch (err) {
    console.error('[cron] Unhandled error:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};

module.exports.processOrderDailyEmail = processOrderDailyEmail;
module.exports.STAGES = STAGES;
module.exports.calculateSADaysElapsed = calculateSADaysElapsed;
module.exports.getSADateIso = getSADateIso;
module.exports.formatOrderDateShort = formatOrderDateShort;
module.exports.formatDeliveryDateLong = formatDeliveryDateLong;
module.exports.formatDeliveryDateShort = formatDeliveryDateShort;
