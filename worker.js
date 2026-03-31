import matchesModule from "./data/matches.js";
import { encrypt as sabpaisaEncrypt, decrypt as sabpaisaDecrypt } from "sabpaisa-encryption-package-gcm";

const { getAllMatches, getMatchBySlug } = matchesModule;

const CURRENCY = "INR";
const ORDER_TTL_SECONDS = 30 * 60;
const memoryPendingOrders = new Map();
const soldStateBySection = new Map();
let soldStateInitialized = false;

function asString(value) {
  return String(value ?? "").trim();
}

function toInt(value, fallback, options = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (options.min != null && parsed < options.min) return options.min;
  if (options.max != null && parsed > options.max) return options.max;
  return parsed;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nowIso() {
  return new Date().toISOString();
}

function randomHex(length = 8) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

function createOrderReference() {
  return `SP${Date.now().toString(36).toUpperCase()}${randomHex(6).toUpperCase()}`;
}

function createBookingId() {
  return `IPL-${Date.now().toString(36).toUpperCase()}-${randomHex(6).toUpperCase()}`;
}

function sectionKey(matchSlug, sectionId) {
  return `${matchSlug}::${sectionId}`;
}

function initializeSoldState() {
  if (soldStateInitialized) return;
  for (const match of getAllMatches()) {
    for (const section of match.sections) {
      soldStateBySection.set(sectionKey(match.slug, section.id), section.baseSold);
    }
  }
  soldStateInitialized = true;
}

function getMatchPhase(dateTime) {
  const startMs = new Date(dateTime).getTime();
  const nowMs = Date.now();
  const endMs = startMs + 4 * 60 * 60 * 1000;

  if (Number.isNaN(startMs) || nowMs < startMs) {
    return { matchPhase: "Upcoming", matchStatusText: "Scheduled" };
  }
  if (nowMs <= endMs) {
    return { matchPhase: "Running", matchStatusText: "In Progress" };
  }
  return { matchPhase: "Completed", matchStatusText: "Match ended" };
}

function getSectionStatus(available, capacity) {
  if (available <= 0) return "Sold Out";
  if (available <= Math.max(20, Math.round(capacity * 0.1))) return "Almost Gone";
  if (available <= Math.round(capacity * 0.25)) return "Limited";
  return "Available";
}

function getMatchStatus(seatsLeft, totalCapacity) {
  if (seatsLeft <= 0) return "Sold Out";
  if (seatsLeft <= Math.max(80, Math.round(totalCapacity * 0.12))) return "Almost Gone";
  if (seatsLeft <= Math.round(totalCapacity * 0.3)) return "Limited";
  return "Live";
}

function getDynamicPrice(basePrice, capacity, sold) {
  const soldRatio = capacity <= 0 ? 1 : sold / capacity;
  let multiplier = 1;
  if (soldRatio > 0.9) multiplier = 1.25;
  else if (soldRatio > 0.8) multiplier = 1.16;
  else if (soldRatio > 0.65) multiplier = 1.1;
  return Math.max(100, Math.round((basePrice * multiplier) / 10) * 10);
}

function hydrateMatch(rawMatch, matchStatusProvider) {
  initializeSoldState();

  const sections = rawMatch.sections.map((section) => {
    const key = sectionKey(rawMatch.slug, section.id);
    const sold = soldStateBySection.get(key) ?? section.baseSold;
    const available = Math.max(0, section.capacity - sold);
    return {
      ...section,
      sold,
      available,
      dynamicPrice: getDynamicPrice(section.price, section.capacity, sold),
      status: getSectionStatus(available, section.capacity)
    };
  });

  const seatsLeft = sections.reduce((sum, section) => sum + section.available, 0);
  const totalCapacity = sections.reduce((sum, section) => sum + section.capacity, 0);
  const activePrices = sections
    .filter((section) => section.available > 0)
    .map((section) => section.dynamicPrice);
  const phase = getMatchPhase(rawMatch.dateTime);

  return {
    ...rawMatch,
    sections,
    seatsLeft,
    startingPrice: activePrices.length ? Math.min(...activePrices) : null,
    status: getMatchStatus(seatsLeft, totalCapacity),
    matchPhase: phase.matchPhase,
    matchStatusText: phase.matchStatusText,
    matchStatusSource: matchStatusProvider,
    refreshedAt: nowIso()
  };
}

function getHydratedMatch(slug, matchStatusProvider) {
  const raw = getMatchBySlug(slug);
  if (!raw) return null;
  return hydrateMatch(raw, matchStatusProvider);
}

function getHydratedMatches(matchStatusProvider) {
  return getAllMatches().map((match) => hydrateMatch(match, matchStatusProvider));
}

function toMatchSummary(match) {
  const { sections, ...rest } = match;
  return rest;
}

function calculatePricing(unitPrice, quantity) {
  const subtotal = unitPrice * quantity;
  const platformFee = Math.round(subtotal * 0.04);
  const gst = Math.round((subtotal + platformFee) * 0.18);
  const total = subtotal + platformFee + gst;
  return { unitPrice, quantity, subtotal, platformFee, gst, total, currency: CURRENCY };
}

function validateBuyer(buyer) {
  const normalized = {
    name: asString(buyer?.name),
    email: asString(buyer?.email).toLowerCase(),
    phone: asString(buyer?.phone)
  };

  const errors = [];
  if (!normalized.name || normalized.name.length < 2) errors.push("buyer.name is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) errors.push("buyer.email must be valid.");
  if (!/^[0-9+\-\s]{8,15}$/.test(normalized.phone)) errors.push("buyer.phone must be valid.");
  return { buyer: normalized, errors };
}

function getCheckoutProvider(env) {
  return asString(env.CHECKOUT_PROVIDER || "sabpaisa").toLowerCase();
}

function getMatchStatusProvider(env) {
  return asString(env.MATCH_STATUS_PROVIDER || "fallback");
}

function getLiveRefreshIntervalMs(env) {
  return toInt(env.MATCH_STATUS_REFRESH_MS, 20000, { min: 5000, max: 120000 });
}

function isTrueLike(value) {
  return ["1", "true", "yes", "on"].includes(asString(value).toLowerCase());
}

function isProductionSabpaisaEnvironment(value) {
  return ["prod", "production", "live"].includes(asString(value).toLowerCase());
}

function getSabpaisaGatewayUrl(environment) {
  if (isProductionSabpaisaEnvironment(environment)) {
    return "https://securepay.sabpaisa.in/SabPaisa/sabPaisaInit?v=1";
  }
  if (asString(environment).toLowerCase() === "uat") {
    return "https://secure.sabpaisa.in/SabPaisa/sabPaisaInit?v=1";
  }
  return "https://stage-securepay.sabpaisa.in/SabPaisa/sabPaisaInit?v=1";
}

function normalizeBaseUrl(baseUrl) {
  return asString(baseUrl).replace(/\/+$/, "");
}

function normalizeAbsoluteUrl(value) {
  const url = new URL(asString(value));
  url.hash = "";
  if (!url.pathname) {
    url.pathname = "/";
  } else if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

function getRequestOrigin(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function joinBaseUrl(baseUrl, relativePath = "") {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const base = new URL(`${normalizedBase}/`);
  return new URL(relativePath.replace(/^\/+/, ""), base).toString();
}

function buildFailureUrl(baseUrl) {
  const target = new URL(joinBaseUrl(baseUrl));
  target.searchParams.set("payment", "failed");
  return target.toString();
}

function getAppEnvironmentName(env, sabpaisaEnvironment) {
  const explicit = asString(env.NODE_ENV || env.APP_ENV);
  if (explicit) return explicit.toLowerCase();
  return isProductionSabpaisaEnvironment(sabpaisaEnvironment) ? "production" : "development";
}

function looksLikeIpAddress(hostname) {
  const normalized = asString(hostname).toLowerCase();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalized)) return true;
  return normalized.includes(":") && /^[0-9a-f:]+$/i.test(normalized);
}

function isTemporaryPlatformHost(hostname) {
  const normalized = asString(hostname).toLowerCase();
  const suffixes = [
    ".workers.dev",
    ".pages.dev",
    ".vercel.app",
    ".netlify.app",
    ".onrender.com",
    ".railway.app",
    ".up.railway.app",
    ".github.io",
    ".ngrok-free.app",
    ".ngrok.io",
    ".loca.lt"
  ];
  return suffixes.some((suffix) => normalized.endsWith(suffix));
}

function isUnsafeProductionHost(hostname) {
  const normalized = asString(hostname).toLowerCase();
  return (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "0.0.0.0" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    looksLikeIpAddress(normalized) ||
    isTemporaryPlatformHost(normalized)
  );
}

function parseUrlOrNull(value) {
  try {
    return new URL(asString(value));
  } catch {
    return null;
  }
}

function validateConfiguredUrl(errors, label, value, options) {
  const parsed = parseUrlOrNull(value);
  if (!parsed) {
    errors.push(`${label} must be a valid absolute URL.`);
    return;
  }

  if (options.requireHttps && parsed.protocol !== "https:") {
    errors.push(`${label} must use HTTPS in production.`);
  }

  if (options.expectedHost && parsed.hostname !== options.expectedHost) {
    errors.push(`${label} must use the same hostname as APP_BASE_URL (${options.expectedHost}).`);
  }

  if (options.requirePublicHost && isUnsafeProductionHost(parsed.hostname)) {
    errors.push(
      `${label} must use your live public domain, not localhost, an IP address, or a preview host.`
    );
  }
}

function validateGatewayUrl(errors, config) {
  const parsed = parseUrlOrNull(config.urls.gatewayUrl);
  if (!parsed) {
    errors.push("SABPAISA_BASE_URL must be a valid absolute URL.");
    return;
  }

  const expectedHost = isProductionSabpaisaEnvironment(config.environment)
    ? "securepay.sabpaisa.in"
    : config.environment === "uat"
      ? "secure.sabpaisa.in"
      : "stage-securepay.sabpaisa.in";

  if (parsed.hostname !== expectedHost) {
    errors.push(
      `SABPAISA_BASE_URL host ${parsed.hostname} does not match SABPAISA_ENV=${config.environment}. Expected ${expectedHost}.`
    );
  }
}

function getSabpaisaConfig(env, request) {
  const environment = asString(env.SABPAISA_ENV || "stag").toLowerCase();
  const requestOrigin = getRequestOrigin(request);
  const appEnvironment = getAppEnvironmentName(env, environment);
  const appBaseSource =
    asString(env.APP_BASE_URL) ||
    asString(env.SABPAISA_CALLBACK_BASE_URL) ||
    (appEnvironment === "production" ? "" : requestOrigin);
  const appBaseUrl = appBaseSource ? normalizeBaseUrl(appBaseSource) : "";
  const gatewayUrl = asString(env.SABPAISA_BASE_URL) || getSabpaisaGatewayUrl(environment);
  const callbackUrl = appBaseUrl
    ? normalizeAbsoluteUrl(
        asString(env.SABPAISA_CALLBACK_URL) ||
          joinBaseUrl(appBaseUrl, "api/checkout/sabpaisa/response")
      )
    : "";
  const successUrl = appBaseUrl
    ? normalizeAbsoluteUrl(
        asString(env.SABPAISA_SUCCESS_URL) || joinBaseUrl(appBaseUrl, "thankyou.html")
      )
    : "";
  const failureUrl = appBaseUrl
    ? normalizeAbsoluteUrl(asString(env.SABPAISA_FAILURE_URL) || buildFailureUrl(appBaseUrl))
    : "";
  const webhookUrl = appBaseUrl
    ? normalizeAbsoluteUrl(
        asString(env.SABPAISA_WEBHOOK_URL) ||
          asString(env.SABPAISA_CALLBACK_URL) ||
          joinBaseUrl(appBaseUrl, "api/checkout/sabpaisa/response")
      )
    : "";

  return {
    merchantId: asString(env.SABPAISA_MERCHANT_ID),
    clientCode: asString(env.SABPAISA_CLIENT_CODE || env.SABPAISA_MERCHANT_ID),
    transUserName: asString(env.SABPAISA_USERNAME || env.SABPAISA_TRANS_USER_NAME),
    transUserPassword: asString(env.SABPAISA_PASSWORD || env.SABPAISA_TRANS_USER_PASSWORD),
    authKey: asString(env.SABPAISA_KEY || env.SABPAISA_AUTH_KEY),
    authIv: asString(env.SABPAISA_IV || env.SABPAISA_AUTH_IV),
    environment,
    appEnvironment,
    channelId: asString(env.SABPAISA_CHANNEL_ID || "web"),
    debug: isTrueLike(env.SABPAISA_DEBUG),
    requestOrigin,
    urls: {
      appBaseUrl,
      callbackUrl,
      successUrl,
      failureUrl,
      webhookUrl,
      gatewayUrl
    }
  };
}

function isSabpaisaConfigured(config) {
  return Boolean(
    config.clientCode &&
      config.transUserName &&
      config.transUserPassword &&
      config.authKey &&
      config.authIv
  );
}

function validateSabpaisaConfig(config, checkoutProvider) {
  const errors = [];

  if (checkoutProvider !== "sabpaisa") {
    return errors;
  }

  if (!config.clientCode) errors.push("SABPAISA_CLIENT_CODE is required.");
  if (!config.transUserName) errors.push("SABPAISA_USERNAME is required.");
  if (!config.transUserPassword) errors.push("SABPAISA_PASSWORD is required.");
  if (!config.authKey) errors.push("SABPAISA_KEY is required.");
  if (!config.authIv) errors.push("SABPAISA_AUTH_IV is required.");
  if (!config.urls.appBaseUrl) {
    errors.push("APP_BASE_URL is required when SabPaisa checkout is enabled.");
    return errors;
  }

  const appBaseUrl = parseUrlOrNull(config.urls.appBaseUrl);
  if (!appBaseUrl) {
    errors.push("APP_BASE_URL must be a valid absolute URL.");
    return errors;
  }

  const requireHttps = config.appEnvironment === "production";
  const requirePublicHost = config.appEnvironment === "production";

  if (requireHttps && appBaseUrl.protocol !== "https:") {
    errors.push("APP_BASE_URL must use HTTPS in production.");
  }

  if (requirePublicHost && isUnsafeProductionHost(appBaseUrl.hostname)) {
    errors.push(
      "APP_BASE_URL must use your live public domain, not localhost, an IP address, or a preview host."
    );
  }

  validateConfiguredUrl(errors, "SABPAISA_CALLBACK_URL", config.urls.callbackUrl, {
    expectedHost: appBaseUrl.hostname,
    requireHttps,
    requirePublicHost
  });
  validateConfiguredUrl(errors, "SABPAISA_SUCCESS_URL", config.urls.successUrl, {
    expectedHost: appBaseUrl.hostname,
    requireHttps,
    requirePublicHost
  });
  validateConfiguredUrl(errors, "SABPAISA_FAILURE_URL", config.urls.failureUrl, {
    expectedHost: appBaseUrl.hostname,
    requireHttps,
    requirePublicHost
  });
  validateConfiguredUrl(errors, "SABPAISA_WEBHOOK_URL", config.urls.webhookUrl, {
    expectedHost: appBaseUrl.hostname,
    requireHttps,
    requirePublicHost
  });
  validateGatewayUrl(errors, config);

  return errors;
}

function logSabpaisaDebug(config, details = {}) {
  if (!config.debug) return;

  const configuredHost = parseUrlOrNull(config.urls.appBaseUrl)?.hostname || "";
  const requestHost = parseUrlOrNull(config.requestOrigin)?.hostname || "";

  console.log(
    JSON.stringify({
      tag: "sabpaisa",
      environment: config.environment,
      appEnvironment: config.appEnvironment,
      requestOrigin: config.requestOrigin,
      configuredAppBaseUrl: config.urls.appBaseUrl,
      callbackUrl: config.urls.callbackUrl,
      successUrl: config.urls.successUrl,
      failureUrl: config.urls.failureUrl,
      webhookUrl: config.urls.webhookUrl,
      gatewayUrl: config.urls.gatewayUrl,
      hostMismatch: Boolean(configuredHost && requestHost && configuredHost !== requestHost),
      ...details
    })
  );
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function apiError(message, status = 400, details) {
  const payload = { error: message };
  if (Array.isArray(details) && details.length > 0) payload.details = details;
  return jsonResponse(payload, status);
}

function getFailureRedirect(sabpaisaConfig, reason) {
  const target = new URL(sabpaisaConfig.urls.failureUrl);
  target.searchParams.set("payment", "failed");
  target.searchParams.set("reason", asString(reason || "Payment failed."));
  return Response.redirect(target.toString(), 302);
}

function getSuccessRedirect(sabpaisaConfig, finalized) {
  const matchStart = new Date(finalized.match.dateTime);
  const validDate = Number.isFinite(matchStart.getTime());

  const dateLabel = validDate
    ? new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric"
      }).format(matchStart)
    : "Match Day";

  const timeLabel = validDate
    ? new Intl.DateTimeFormat("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }).format(matchStart)
    : "TBA";

  const target = new URL(sabpaisaConfig.urls.successUrl);
  const matchLabel =
    finalized.pending?.legacy?.matchTitle ||
    `${finalized.match.homeTeam} vs ${finalized.match.awayTeam}`;
  const seatLabel =
    finalized.pending?.legacy?.seatLabel ||
    `${finalized.pending.quantity} x ${finalized.section.label}`;

  target.search = new URLSearchParams({
    id: finalized.booking.bookingId,
    match: matchLabel,
    date: dateLabel,
    time: timeLabel,
    city: finalized.match.city,
    stadium: finalized.match.stadium,
    seats: seatLabel,
    name: finalized.pending.buyer.name,
    email: finalized.pending.buyer.email,
    total: String(finalized.booking.amountPaid)
  }).toString();
  return Response.redirect(target.toString(), 302);
}

function orderStoreKey(orderReference) {
  return `order:${orderReference}`;
}

async function savePendingOrder(env, orderReference, orderData) {
  if (env.ORDERS_KV && typeof env.ORDERS_KV.put === "function") {
    await env.ORDERS_KV.put(orderStoreKey(orderReference), JSON.stringify(orderData), {
      expirationTtl: ORDER_TTL_SECONDS
    });
    return;
  }

  memoryPendingOrders.set(orderReference, {
    ...orderData,
    __expiresAt: Date.now() + ORDER_TTL_SECONDS * 1000
  });
}

async function readPendingOrder(env, orderReference) {
  if (env.ORDERS_KV && typeof env.ORDERS_KV.get === "function") {
    const raw = await env.ORDERS_KV.get(orderStoreKey(orderReference));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  const pending = memoryPendingOrders.get(orderReference);
  if (!pending) return null;
  if (Date.now() > Number(pending.__expiresAt || 0)) {
    memoryPendingOrders.delete(orderReference);
    return null;
  }
  return pending;
}

async function deletePendingOrder(env, orderReference) {
  if (env.ORDERS_KV && typeof env.ORDERS_KV.delete === "function") {
    await env.ORDERS_KV.delete(orderStoreKey(orderReference));
    return;
  }
  memoryPendingOrders.delete(orderReference);
}

function finalizeOrder(orderReference, pendingOrder) {
  if (pendingOrder.legacy) {
    return {
      ok: true,
      booking: {
        bookingId: createBookingId(),
        orderReference,
        paymentId: pendingOrder.paymentId || null,
        provider: "sabpaisa",
        quantity: pendingOrder.quantity,
        amountPaid: pendingOrder.pricing.total,
        currency: pendingOrder.pricing.currency,
        matchSlug: "legacy",
        sectionId: "legacy",
        purchasedAt: nowIso()
      },
      pending: pendingOrder,
      match: {
        homeTeam: pendingOrder.legacy.matchTitle || "IPL Match",
        awayTeam: "",
        city: pendingOrder.legacy.city || "",
        stadium: pendingOrder.legacy.stadium || "",
        dateTime: nowIso()
      },
      section: {
        label: pendingOrder.legacy.seatLabel || "Selected Seats"
      }
    };
  }

  const sourceMatch = getMatchBySlug(pendingOrder.matchSlug);
  if (!sourceMatch) {
    return { ok: false, statusCode: 404, error: "Match no longer available." };
  }

  const sourceSection = sourceMatch.sections.find((section) => section.id === pendingOrder.sectionId);
  if (!sourceSection) {
    return { ok: false, statusCode: 404, error: "Section no longer available." };
  }

  initializeSoldState();
  const key = sectionKey(pendingOrder.matchSlug, pendingOrder.sectionId);
  const sold = soldStateBySection.get(key) ?? sourceSection.baseSold;
  const available = sourceSection.capacity - sold;
  if (available < pendingOrder.quantity) {
    return {
      ok: false,
      statusCode: 409,
      error: `Only ${Math.max(0, available)} ticket(s) are available now.`
    };
  }

  soldStateBySection.set(key, clamp(sold + pendingOrder.quantity, 0, sourceSection.capacity));

  return {
    ok: true,
    booking: {
      bookingId: createBookingId(),
      orderReference,
      paymentId: pendingOrder.paymentId || null,
      provider: "sabpaisa",
      quantity: pendingOrder.quantity,
      amountPaid: pendingOrder.pricing.total,
      currency: pendingOrder.pricing.currency,
      matchSlug: pendingOrder.matchSlug,
      sectionId: pendingOrder.sectionId,
      purchasedAt: nowIso()
    },
    pending: pendingOrder,
    match: sourceMatch,
    section: sourceSection
  };
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function extractGatewayResponse(request, url) {
  const fromQuery = asString(url.searchParams.get("encResponse") || url.searchParams.get("responseQuery"));
  if (fromQuery) return fromQuery;

  const contentType = asString(request.headers.get("content-type")).toLowerCase();

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (form) {
      return asString(form.get("encResponse") || form.get("responseQuery") || form.get("encData"));
    }
  }

  if (contentType.includes("application/json")) {
    const body = await parseJsonBody(request);
    return asString(body.encResponse || body.responseQuery || body.encData);
  }

  return "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();

    const checkoutProvider = getCheckoutProvider(env);
    const matchStatusProvider = getMatchStatusProvider(env);
    const liveRefreshIntervalMs = getLiveRefreshIntervalMs(env);
    const sabpaisaConfig = getSabpaisaConfig(env, request);
    const sabpaisaEnabled = isSabpaisaConfigured(sabpaisaConfig);
    const sabpaisaConfigErrors = validateSabpaisaConfig(sabpaisaConfig, checkoutProvider);

    try {
      if (method === "GET" && pathname === "/api/config") {
        const payload = {
          checkoutProvider: "sabpaisa",
          checkoutFallbackFrom: null,
          razorpayKeyId: null,
          sabpaisaEnv: sabpaisaConfig.environment,
          sabpaisaEnabled,
          appBaseUrl: sabpaisaConfig.urls.appBaseUrl || null,
          liveRefreshIntervalMs,
          matchStatusProvider,
          currency: CURRENCY,
          orderStore: env.ORDERS_KV ? "kv" : "memory",
          sabpaisaConfigErrors
        };

        if (sabpaisaConfig.debug) {
          payload.sabpaisaUrls = {
            gatewayUrl: sabpaisaConfig.urls.gatewayUrl,
            callbackUrl: sabpaisaConfig.urls.callbackUrl,
            successUrl: sabpaisaConfig.urls.successUrl,
            failureUrl: sabpaisaConfig.urls.failureUrl,
            webhookUrl: sabpaisaConfig.urls.webhookUrl
          };
        }

        return jsonResponse(payload);
      }

      if (method === "GET" && pathname === "/api/matches") {
        const matches = getHydratedMatches(matchStatusProvider).map((match) => toMatchSummary(match));
        return jsonResponse({
          refreshedAt: nowIso(),
          matchStatusSource: matchStatusProvider,
          matches
        });
      }

      if (method === "GET" && pathname.startsWith("/api/matches/")) {
        const slug = decodeURIComponent(pathname.replace("/api/matches/", ""));
        const match = getHydratedMatch(slug, matchStatusProvider);
        if (!match) return apiError("Match not found.", 404);
        return jsonResponse({ match });
      }

      if (method === "POST" && pathname === "/api/checkout/create-order") {
        if (checkoutProvider !== "sabpaisa") {
          return apiError("Only SabPaisa checkout is enabled on this deployment.", 503);
        }

        if (sabpaisaConfigErrors.length > 0) {
          return apiError("Invalid SabPaisa configuration.", 500, sabpaisaConfigErrors);
        }

        if (!sabpaisaEnabled) {
          return apiError("SabPaisa credentials are missing in Cloudflare variables.", 500);
        }

        if (
          sabpaisaConfig.appEnvironment === "production" &&
          parseUrlOrNull(sabpaisaConfig.requestOrigin)?.hostname !==
            parseUrlOrNull(sabpaisaConfig.urls.appBaseUrl)?.hostname
        ) {
          return apiError(
            `SabPaisa checkout must be initiated from ${sabpaisaConfig.urls.appBaseUrl}.`,
            409
          );
        }

        const body = await parseJsonBody(request);
        const legacyCheckout = body?.legacyCheckout || null;
        const matchSlug = asString(body?.matchSlug);
        const sectionId = asString(body?.sectionId);
        const quantity = Number.parseInt(body?.quantity, 10);
        const { buyer, errors: buyerErrors } = validateBuyer(body?.buyer);

        const validationErrors = [...buyerErrors];
        const orderReference = createOrderReference();
        const callbackUrl = sabpaisaConfig.urls.callbackUrl;

        logSabpaisaDebug(sabpaisaConfig, {
          event: "create-order",
          orderReference,
          domainUsed: sabpaisaConfig.urls.appBaseUrl,
          callbackUrl: sabpaisaConfig.urls.callbackUrl,
          successUrl: sabpaisaConfig.urls.successUrl,
          failureUrl: sabpaisaConfig.urls.failureUrl,
          webhookUrl: sabpaisaConfig.urls.webhookUrl
        });

        if (legacyCheckout) {
          const amount = Number(legacyCheckout.amount);
          const legacyQuantity = Number.parseInt(legacyCheckout.quantity, 10) || 1;
          const matchTitle = asString(legacyCheckout.matchTitle || "IPL Match");
          const seatLabel = asString(legacyCheckout.seatLabel || "Selected Seats");
          const city = asString(legacyCheckout.city || "");
          const stadium = asString(legacyCheckout.stadium || "");

          if (!Number.isFinite(amount) || amount <= 0) {
            validationErrors.push("legacyCheckout.amount must be a valid number.");
          }
          if (!Number.isInteger(legacyQuantity) || legacyQuantity < 1 || legacyQuantity > 50) {
            validationErrors.push("legacyCheckout.quantity must be between 1 and 50.");
          }
          if (!matchTitle) {
            validationErrors.push("legacyCheckout.matchTitle is required.");
          }

          if (validationErrors.length > 0) {
            return apiError("Validation failed.", 400, validationErrors);
          }

          const pricing = {
            unitPrice: Math.round((amount / legacyQuantity) * 100) / 100,
            quantity: legacyQuantity,
            subtotal: amount,
            platformFee: 0,
            gst: 0,
            total: amount,
            currency: CURRENCY
          };

          const gatewayPayload = new URLSearchParams({
            payerName: buyer.name,
            payerEmail: buyer.email,
            payerMobile: buyer.phone,
            clientTxnId: orderReference,
            amount: pricing.total.toFixed(2),
            amountType: pricing.currency,
            clientCode: sabpaisaConfig.clientCode,
            transUserName: sabpaisaConfig.transUserName,
            transUserPassword: sabpaisaConfig.transUserPassword,
            callbackUrl,
            channelId: sabpaisaConfig.channelId,
            udf1: matchTitle,
            udf2: seatLabel,
            udf3: String(legacyQuantity),
            udf4: String(pricing.total)
          }).toString();

          let encData;
          try {
            encData = await sabpaisaEncrypt(
              gatewayPayload,
              sabpaisaConfig.authKey,
              sabpaisaConfig.authIv
            );
          } catch {
            return apiError("Unable to initiate SabPaisa checkout.", 502);
          }

          await savePendingOrder(env, orderReference, {
            mode: "sabpaisa",
            orderReference,
            quantity: legacyQuantity,
            buyer,
            pricing,
            createdAt: Date.now(),
            paymentId: null,
            legacy: {
              matchTitle,
              seatLabel,
              city,
              stadium
            }
          });

          return jsonResponse(
            {
              mode: "sabpaisa",
              orderReference,
              match: {
                slug: "legacy",
                homeTeam: matchTitle,
                awayTeam: "",
                dateTime: nowIso(),
                stadium,
                city
              },
              section: {
                id: "legacy",
                label: seatLabel,
                stand: "Selected Seats",
                selectedUnitPrice: pricing.unitPrice
              },
              quantity: legacyQuantity,
              pricing,
              sabpaisa: {
                gatewayUrl: sabpaisaConfig.urls.gatewayUrl,
                clientCode: sabpaisaConfig.clientCode,
                encData,
                appBaseUrl: sabpaisaConfig.urls.appBaseUrl,
                callbackUrl: sabpaisaConfig.urls.callbackUrl,
                successUrl: sabpaisaConfig.urls.successUrl,
                failureUrl: sabpaisaConfig.urls.failureUrl,
                webhookUrl: sabpaisaConfig.urls.webhookUrl
              }
            },
            201
          );
        }

        if (!matchSlug) validationErrors.push("matchSlug is required.");
        if (!sectionId) validationErrors.push("sectionId is required.");
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 8) {
          validationErrors.push("quantity must be an integer between 1 and 8.");
        }
        if (validationErrors.length > 0) {
          return apiError("Validation failed.", 400, validationErrors);
        }

        const match = getHydratedMatch(matchSlug, matchStatusProvider);
        if (!match) return apiError("Match not found.", 404);

        const section = match.sections.find((item) => item.id === sectionId);
        if (!section) return apiError("Section not found.", 404);

        if (section.available < quantity) {
          return apiError(`Only ${section.available} ticket(s) are available for this section.`, 409);
        }

        const pricing = calculatePricing(section.dynamicPrice, quantity);
        const gatewayPayload = new URLSearchParams({
          payerName: buyer.name,
          payerEmail: buyer.email,
          payerMobile: buyer.phone,
          clientTxnId: orderReference,
          amount: pricing.total.toFixed(2),
          amountType: pricing.currency,
          clientCode: sabpaisaConfig.clientCode,
          transUserName: sabpaisaConfig.transUserName,
          transUserPassword: sabpaisaConfig.transUserPassword,
          callbackUrl,
          channelId: sabpaisaConfig.channelId,
          udf1: match.slug,
          udf2: section.id,
          udf3: String(quantity),
          udf4: String(section.dynamicPrice)
        }).toString();

        let encData;
        try {
          encData = await sabpaisaEncrypt(
            gatewayPayload,
            sabpaisaConfig.authKey,
            sabpaisaConfig.authIv
          );
        } catch {
          return apiError("Unable to initiate SabPaisa checkout.", 502);
        }

        await savePendingOrder(env, orderReference, {
          mode: "sabpaisa",
          orderReference,
          matchSlug: match.slug,
          sectionId: section.id,
          quantity,
          buyer,
          pricing,
          createdAt: Date.now(),
          paymentId: null
        });

        return jsonResponse(
          {
            mode: "sabpaisa",
            orderReference,
            match: {
              slug: match.slug,
              homeTeam: match.homeTeam,
              awayTeam: match.awayTeam,
              dateTime: match.dateTime,
              stadium: match.stadium,
              city: match.city
            },
            section: {
              id: section.id,
              label: section.label,
              stand: section.stand,
              selectedUnitPrice: section.dynamicPrice
            },
            quantity,
            pricing,
            sabpaisa: {
              gatewayUrl: sabpaisaConfig.urls.gatewayUrl,
              clientCode: sabpaisaConfig.clientCode,
              encData,
              appBaseUrl: sabpaisaConfig.urls.appBaseUrl,
              callbackUrl: sabpaisaConfig.urls.callbackUrl,
              successUrl: sabpaisaConfig.urls.successUrl,
              failureUrl: sabpaisaConfig.urls.failureUrl,
              webhookUrl: sabpaisaConfig.urls.webhookUrl
            }
          },
          201
        );
      }

      if (
        pathname === "/api/checkout/sabpaisa/response" ||
        pathname === "/api/payments/sabpaisa/callback" ||
        pathname === "/api/payments/sabpaisa/webhook"
      ) {
        if (sabpaisaConfigErrors.length > 0) {
          return getFailureRedirect(sabpaisaConfig, "Invalid SabPaisa configuration on this deployment.");
        }

        if (!sabpaisaEnabled) {
          return getFailureRedirect(sabpaisaConfig, "SabPaisa is not configured on this deployment.");
        }

        const encryptedResponse = asString(await extractGatewayResponse(request, url)).replace(/ /g, "+");
        if (!encryptedResponse) {
          return getFailureRedirect(sabpaisaConfig, "Missing SabPaisa response payload.");
        }

        let payload = null;
        try {
          const decrypted = await sabpaisaDecrypt(
            encryptedResponse,
            sabpaisaConfig.authKey,
            sabpaisaConfig.authIv
          );
          payload = Object.fromEntries(
            new URLSearchParams(asString(decrypted || "")).entries()
          );
        } catch {
          return getFailureRedirect(sabpaisaConfig, "Unable to verify SabPaisa response.");
        }

        const orderReference = asString(
          payload?.clientTxnId || payload?.order_id || payload?.orderReference
        );
        if (!orderReference) {
          return getFailureRedirect(sabpaisaConfig, "Missing order id in gateway response.");
        }

        const pendingOrder = await readPendingOrder(env, orderReference);
        if (!pendingOrder || pendingOrder.mode !== "sabpaisa") {
          return getFailureRedirect(sabpaisaConfig, "Order session expired. Please retry checkout.");
        }

        const status = asString(
          payload?.status || payload?.Status || payload?.order_status
        ).toLowerCase();
        const respCode = asString(payload?.sabPaisaRespCode || payload?.respCode);
        const success =
          status === "success" ||
          status === "successful" ||
          (respCode === "0000" && status !== "failure" && status !== "failed");

        if (!success) {
          await deletePendingOrder(env, orderReference);
          return getFailureRedirect(sabpaisaConfig, `Payment ${status || "failed"}.`);
        }

        const paidAmount = Number(
          payload?.paidAmount || payload?.amount || payload?.Amount || 0
        );
        if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - pendingOrder.pricing.total) > 0.01) {
          await deletePendingOrder(env, orderReference);
          return getFailureRedirect(sabpaisaConfig, "Amount mismatch in gateway response.");
        }

        pendingOrder.paymentId = asString(
          payload?.txnId || payload?.transactionId || payload?.bankTxnId || ""
        );

        const finalized = finalizeOrder(orderReference, pendingOrder);
        await deletePendingOrder(env, orderReference);

        if (!finalized.ok) {
          return getFailureRedirect(sabpaisaConfig, finalized.error);
        }

        return getSuccessRedirect(sabpaisaConfig, finalized);
      }

      if (method === "GET" && pathname === "/payment/success") {
        const target = new URL("/thankyou.html", request.url);
        target.search = url.search;
        return Response.redirect(target.toString(), 302);
      }

      if (method === "GET" && pathname === "/payment/failure") {
        const target = new URL("/", request.url);
        target.search = url.search;
        if (!target.searchParams.has("payment")) {
          target.searchParams.set("payment", "failed");
        }
        return Response.redirect(target.toString(), 302);
      }

      if (method === "POST" && pathname === "/api/checkout/verify") {
        return apiError(
          "SabPaisa payments are verified only through /api/checkout/sabpaisa/response callback.",
          409
        );
      }

      if (pathname.startsWith("/api/")) {
        return apiError("API route not found.", 404);
      }

      if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
        return env.ASSETS.fetch(request);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (pathname.startsWith("/api/")) {
        return apiError("Unexpected server error.", 500, [asString(error?.message)]);
      }
      return new Response("Unexpected server error.", { status: 500 });
    }
  }
};
