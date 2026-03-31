"use strict";

const crypto = require("crypto");
const path = require("path");

const dotenv = require("dotenv");
const express = require("express");

const { getAllMatches, getMatchBySlug } = require("./data/matches");

dotenv.config();

const app = express();

const PORT = toInt(process.env.PORT, 3000, { min: 1, max: 65535 });
const CURRENCY = "INR";
const ORDER_TTL_MS = 30 * 60 * 1000;
const LIVE_REFRESH_INTERVAL_MS = toInt(process.env.MATCH_STATUS_REFRESH_MS, 20000, {
  min: 5000,
  max: 120000
});
const MATCH_STATUS_PROVIDER = asString(process.env.MATCH_STATUS_PROVIDER || "fallback");
const CHECKOUT_PROVIDER = asString(process.env.CHECKOUT_PROVIDER || "sabpaisa").toLowerCase();
const SABPAISA_CONFIG = getSabpaisaConfig(process.env);
const SABPAISA_CONFIG_ERRORS = validateSabpaisaConfig(SABPAISA_CONFIG, CHECKOUT_PROVIDER);
const isSabpaisaConfigured = isSabpaisaConfiguredForRuntime(SABPAISA_CONFIG);

const soldStateBySection = new Map();
const pendingOrders = new Map();

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));
app.use("/public", express.static(path.join(__dirname, "public"), { dotfiles: "ignore" }));

const asyncHandler =
  (handler) =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

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

function toFlexibleNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : Number.NaN;
  }

  const normalized = asString(value).replace(/,/g, "").replace(/[^\d.-]/g, "");
  if (!normalized) {
    return Number.NaN;
  }

  return Number.parseFloat(normalized);
}

function toFlexibleInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const normalized = asString(value).replace(/[^\d-]/g, "");
  if (!normalized) {
    return Number.NaN;
  }

  return Number.parseInt(normalized, 10);
}

function getBase64ByteLength(value) {
  const normalized = asString(value);
  if (!normalized || /[^A-Za-z0-9+/=]/.test(normalized) || normalized.length % 4 !== 0) {
    return null;
  }

  try {
    const buffer = Buffer.from(normalized, "base64");
    if (!buffer.length) {
      return null;
    }
    return buffer.length;
  } catch {
    return null;
  }
}

function getSabpaisaCryptoMeta(config) {
  return {
    authKeyLength: asString(config.authKey).length,
    authKeyBytes: getBase64ByteLength(config.authKey),
    authIvLength: asString(config.authIv).length,
    authIvBytes: getBase64ByteLength(config.authIv)
  };
}

function bytesToUpperHex(buffer) {
  return Buffer.from(buffer).toString("hex").toUpperCase();
}

function hexToBytes(value) {
  return Buffer.from(asString(value), "hex");
}

function safeBufferEquals(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function sabpaisaDecryptPayload(hexCiphertext, authKeyValue, authIvValue, suppressError = false) {
  try {
    const authKey = Buffer.from(authKeyValue, "base64");
    const authIv = Buffer.from(authIvValue, "base64");
    const fullMessage = hexToBytes(hexCiphertext);

    if (fullMessage.length < 76) {
      throw new Error("Invalid ciphertext");
    }

    const hmacReceived = fullMessage.subarray(0, 48);
    const encryptedData = fullMessage.subarray(48);
    const hmacCalculated = crypto.createHmac("sha384", authIv).update(encryptedData).digest();

    if (!safeBufferEquals(hmacReceived, hmacCalculated)) {
      throw new Error("HMAC validation failed");
    }

    const iv = encryptedData.subarray(0, 12);
    const ciphertextWithTag = encryptedData.subarray(12);
    const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
    const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);

    const decipher = crypto.createDecipheriv("aes-256-gcm", authKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return plaintext.toString("utf8");
  } catch (error) {
    if (!suppressError) {
      console.error("[sabpaisa] Decryption failed", {
        message: error?.message || "Unknown error"
      });
    }
    return hexCiphertext;
  }
}

function sabpaisaEncryptPayload(plaintext, authKeyValue, authIvValue) {
  if (!plaintext) {
    return plaintext;
  }

  const authKey = Buffer.from(authKeyValue, "base64");
  const authIv = Buffer.from(authIvValue, "base64");
  const iv = authKey.subarray(0, 12);

  const cipher = crypto.createCipheriv("aes-256-gcm", authKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  const encryptedMessage = Buffer.concat([iv, ciphertext, tag]);
  const hmacCalculated = crypto.createHmac("sha384", authIv).update(encryptedMessage).digest();
  return bytesToUpperHex(Buffer.concat([hmacCalculated, encryptedMessage]));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sectionKey(matchSlug, sectionId) {
  return `${matchSlug}::${sectionId}`;
}

function randomId(length = 8) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

function nowIso() {
  return new Date().toISOString();
}

function createOrderReference() {
  return `SP${Date.now().toString(36).toUpperCase()}${randomId(6).toUpperCase()}`;
}

function createBookingId() {
  return `IPL-${Date.now().toString(36).toUpperCase()}-${randomId(6).toUpperCase()}`;
}

function normalizeBaseUrl(baseUrl) {
  return asString(baseUrl).replace(/\/+$/, "");
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

function getRequestOrigin(req) {
  const forwardedProto = asString(req.headers["x-forwarded-proto"]).split(",")[0].trim();
  const forwardedHost = asString(req.headers["x-forwarded-host"]).split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || `localhost:${PORT}`;
  return `${protocol}://${host}`;
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

function validateSabpaisaCryptoConfig(errors, config) {
  const cryptoMeta = getSabpaisaCryptoMeta(config);

  if (config.authKey && cryptoMeta.authKeyBytes == null) {
    errors.push("SABPAISA_KEY must be valid base64.");
  } else if (config.authKey && cryptoMeta.authKeyBytes !== 32) {
    errors.push("SABPAISA_KEY must decode to 32 bytes.");
  }

  if (config.authIv && cryptoMeta.authIvBytes == null) {
    errors.push("SABPAISA_IV must be valid base64.");
  } else if (config.authIv && cryptoMeta.authIvBytes !== 48) {
    errors.push("SABPAISA_IV must decode to 48 bytes.");
  }
}

function getSabpaisaConfig(env, req) {
  const environment = asString(env.SABPAISA_ENV || "stag").toLowerCase();
  const requestOrigin = req ? getRequestOrigin(req) : "";
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

function isSabpaisaConfiguredForRuntime(config) {
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
  if (!config.authIv) errors.push("SABPAISA_IV is required.");
  if (!config.urls.appBaseUrl) {
    errors.push("APP_BASE_URL is required when SabPaisa checkout is enabled.");
    return errors;
  }

  validateSabpaisaCryptoConfig(errors, config);

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

if (CHECKOUT_PROVIDER === "sabpaisa" && SABPAISA_CONFIG.appEnvironment === "production" && SABPAISA_CONFIG_ERRORS.length > 0) {
  throw new Error(`Invalid SabPaisa configuration: ${SABPAISA_CONFIG_ERRORS.join(" | ")}`);
}

function initializeSoldState() {
  for (const match of getAllMatches()) {
    for (const section of match.sections) {
      soldStateBySection.set(sectionKey(match.slug, section.id), section.baseSold);
    }
  }
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

function hydrateMatch(rawMatch) {
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
  const activePrices = sections.filter((section) => section.available > 0).map((section) => section.dynamicPrice);
  const phase = getMatchPhase(rawMatch.dateTime);

  return {
    ...rawMatch,
    sections,
    seatsLeft,
    startingPrice: activePrices.length ? Math.min(...activePrices) : null,
    status: getMatchStatus(seatsLeft, totalCapacity),
    matchPhase: phase.matchPhase,
    matchStatusText: phase.matchStatusText,
    matchStatusSource: MATCH_STATUS_PROVIDER,
    refreshedAt: nowIso()
  };
}

function getHydratedMatch(slug) {
  const rawMatch = getMatchBySlug(slug);
  if (!rawMatch) return null;
  return hydrateMatch(rawMatch);
}

function getHydratedMatches() {
  return getAllMatches().map((match) => hydrateMatch(match));
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

function cleanupPendingOrders() {
  const now = Date.now();
  for (const [orderReference, order] of pendingOrders.entries()) {
    if (now - order.createdAt > ORDER_TTL_MS) {
      pendingOrders.delete(orderReference);
    }
  }
}

function finalizeOrder(orderReference) {
  const pending = pendingOrders.get(orderReference);
  if (!pending) {
    return { ok: false, statusCode: 404, error: "Order reference not found or expired." };
  }

  if (pending.legacy) {
    pendingOrders.delete(orderReference);
    return {
      ok: true,
      booking: {
        bookingId: createBookingId(),
        orderReference,
        paymentId: pending.paymentId || null,
        provider: "sabpaisa",
        quantity: pending.quantity,
        amountPaid: pending.pricing.total,
        currency: pending.pricing.currency,
        matchSlug: "legacy",
        sectionId: "legacy",
        purchasedAt: nowIso()
      },
      pending,
      match: {
        homeTeam: pending.legacy.matchTitle || "IPL Match",
        awayTeam: "",
        city: pending.legacy.city || "",
        stadium: pending.legacy.stadium || "",
        dateTime: nowIso()
      },
      section: {
        label: pending.legacy.seatLabel || "Selected Seats"
      }
    };
  }

  const sourceMatch = getMatchBySlug(pending.matchSlug);
  if (!sourceMatch) {
    pendingOrders.delete(orderReference);
    return { ok: false, statusCode: 404, error: "Match no longer available." };
  }

  const sourceSection = sourceMatch.sections.find((section) => section.id === pending.sectionId);
  if (!sourceSection) {
    pendingOrders.delete(orderReference);
    return { ok: false, statusCode: 404, error: "Section no longer available." };
  }

  const key = sectionKey(pending.matchSlug, pending.sectionId);
  const sold = soldStateBySection.get(key) ?? sourceSection.baseSold;
  const available = sourceSection.capacity - sold;
  if (available < pending.quantity) {
    pendingOrders.delete(orderReference);
    return {
      ok: false,
      statusCode: 409,
      error: `Only ${Math.max(0, available)} ticket(s) are available now.`
    };
  }

  soldStateBySection.set(key, clamp(sold + pending.quantity, 0, sourceSection.capacity));
  pendingOrders.delete(orderReference);

  return {
    ok: true,
    booking: {
      bookingId: createBookingId(),
      orderReference,
      paymentId: pending.paymentId || null,
      provider: "sabpaisa",
      quantity: pending.quantity,
      amountPaid: pending.pricing.total,
      currency: pending.pricing.currency,
      matchSlug: pending.matchSlug,
      sectionId: pending.sectionId,
      purchasedAt: nowIso()
    },
    pending,
    match: sourceMatch,
    section: sourceSection
  };
}

function buildThankYouParams(finalized) {
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

  return new URLSearchParams({
    id: finalized.booking.bookingId,
    match:
      finalized.pending?.legacy?.matchTitle ||
      `${finalized.match.homeTeam} vs ${finalized.match.awayTeam}`,
    date: dateLabel,
    time: timeLabel,
    city: finalized.match.city,
    stadium: finalized.match.stadium,
    seats:
      finalized.pending?.legacy?.seatLabel ||
      `${finalized.pending.quantity} x ${finalized.section.label}`,
    name: finalized.pending.buyer.name,
    email: finalized.pending.buyer.email,
    total: String(finalized.booking.amountPaid)
  });
}

app.get("/api/config", (req, res) => {
  const payload = {
    checkoutProvider: "sabpaisa",
    checkoutFallbackFrom: null,
    razorpayKeyId: null,
    sabpaisaEnv: SABPAISA_CONFIG.environment,
    sabpaisaEnabled: isSabpaisaConfigured,
    sabpaisaCrypto: getSabpaisaCryptoMeta(SABPAISA_CONFIG),
    appBaseUrl: SABPAISA_CONFIG.urls.appBaseUrl || null,
    liveRefreshIntervalMs: LIVE_REFRESH_INTERVAL_MS,
    matchStatusProvider: MATCH_STATUS_PROVIDER,
    currency: CURRENCY,
    sabpaisaConfigErrors: SABPAISA_CONFIG_ERRORS
  };

  if (SABPAISA_CONFIG.debug) {
    payload.sabpaisaUrls = {
      gatewayUrl: SABPAISA_CONFIG.urls.gatewayUrl,
      callbackUrl: SABPAISA_CONFIG.urls.callbackUrl,
      successUrl: SABPAISA_CONFIG.urls.successUrl,
      failureUrl: SABPAISA_CONFIG.urls.failureUrl,
      webhookUrl: SABPAISA_CONFIG.urls.webhookUrl
    };
  }

  res.json(payload);
});

app.get("/api/matches", (req, res) => {
  const matches = getHydratedMatches().map((match) => toMatchSummary(match));
  res.json({
    refreshedAt: nowIso(),
    matchStatusSource: MATCH_STATUS_PROVIDER,
    matches
  });
});

app.get("/api/matches/:slug", (req, res, next) => {
  const match = getHydratedMatch(req.params.slug);
  if (!match) return next(new HttpError(404, "Match not found."));
  res.json({ match });
});

app.post(
  "/api/checkout/create-order",
  asyncHandler(async (req, res) => {
    if (CHECKOUT_PROVIDER !== "sabpaisa") {
      throw new HttpError(503, "Only SabPaisa checkout is enabled on this server.");
    }

    if (SABPAISA_CONFIG_ERRORS.length > 0) {
      throw new HttpError(500, "Invalid SabPaisa configuration.", SABPAISA_CONFIG_ERRORS);
    }

    if (!isSabpaisaConfigured) {
      throw new HttpError(500, "SabPaisa credentials are missing in environment variables.");
    }

    if (
      SABPAISA_CONFIG.appEnvironment === "production" &&
      parseUrlOrNull(getRequestOrigin(req))?.hostname !==
        parseUrlOrNull(SABPAISA_CONFIG.urls.appBaseUrl)?.hostname
    ) {
      throw new HttpError(
        409,
        `SabPaisa checkout must be initiated from ${SABPAISA_CONFIG.urls.appBaseUrl}.`
      );
    }

    const legacyCheckout = req.body?.legacyCheckout || null;
    const matchSlug = asString(req.body?.matchSlug);
    const sectionId = asString(req.body?.sectionId);
    const quantity = Number.parseInt(req.body?.quantity, 10);
    const { buyer, errors: buyerErrors } = validateBuyer(req.body?.buyer);

    const validationErrors = [...buyerErrors];
    const orderReference = createOrderReference();
    const callbackUrl = SABPAISA_CONFIG.urls.callbackUrl;

    logSabpaisaDebug(
      {
        ...SABPAISA_CONFIG,
        requestOrigin: getRequestOrigin(req)
      },
      {
        event: "create-order",
        orderReference,
        domainUsed: SABPAISA_CONFIG.urls.appBaseUrl,
        callbackUrl: SABPAISA_CONFIG.urls.callbackUrl,
        successUrl: SABPAISA_CONFIG.urls.successUrl,
        failureUrl: SABPAISA_CONFIG.urls.failureUrl,
        webhookUrl: SABPAISA_CONFIG.urls.webhookUrl
      }
    );

    if (legacyCheckout) {
      const amount = toFlexibleNumber(legacyCheckout.amount);
      const parsedLegacyQuantity = toFlexibleInteger(legacyCheckout.quantity);
      const legacyQuantity = Number.isInteger(parsedLegacyQuantity) ? parsedLegacyQuantity : 1;
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
        throw new HttpError(400, "Validation failed.", validationErrors);
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
        clientCode: SABPAISA_CONFIG.clientCode,
        transUserName: SABPAISA_CONFIG.transUserName,
        transUserPassword: SABPAISA_CONFIG.transUserPassword,
        callbackUrl,
        channelId: SABPAISA_CONFIG.channelId,
        udf1: matchTitle,
        udf2: seatLabel,
        udf3: String(legacyQuantity),
        udf4: String(pricing.total)
      }).toString();

      let encData;
      try {
        encData = sabpaisaEncryptPayload(
          gatewayPayload,
          SABPAISA_CONFIG.authKey,
          SABPAISA_CONFIG.authIv
        );
      } catch (error) {
        console.error("[sabpaisa] Failed to build encrypted checkout payload", {
          message: error?.message || "Unknown error",
          ...getSabpaisaCryptoMeta(SABPAISA_CONFIG)
        });
        throw new HttpError(502, "Unable to initiate SabPaisa checkout.");
      }

      pendingOrders.set(orderReference, {
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

      return res.status(201).json({
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
          gatewayUrl: SABPAISA_CONFIG.urls.gatewayUrl,
          clientCode: SABPAISA_CONFIG.clientCode,
          encData,
          appBaseUrl: SABPAISA_CONFIG.urls.appBaseUrl,
          callbackUrl: SABPAISA_CONFIG.urls.callbackUrl,
          successUrl: SABPAISA_CONFIG.urls.successUrl,
          failureUrl: SABPAISA_CONFIG.urls.failureUrl,
          webhookUrl: SABPAISA_CONFIG.urls.webhookUrl
        }
      });
    }

    if (!matchSlug) validationErrors.push("matchSlug is required.");
    if (!sectionId) validationErrors.push("sectionId is required.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 8) {
      validationErrors.push("quantity must be an integer between 1 and 8.");
    }

    if (validationErrors.length > 0) {
      throw new HttpError(400, "Validation failed.", validationErrors);
    }

    const match = getHydratedMatch(matchSlug);
    if (!match) throw new HttpError(404, "Match not found.");

    const section = match.sections.find((item) => item.id === sectionId);
    if (!section) throw new HttpError(404, "Section not found.");

    if (section.available < quantity) {
      throw new HttpError(409, `Only ${section.available} ticket(s) are available for this section.`);
    }

    const pricing = calculatePricing(section.dynamicPrice, quantity);

    const gatewayPayload = new URLSearchParams({
      payerName: buyer.name,
      payerEmail: buyer.email,
      payerMobile: buyer.phone,
      clientTxnId: orderReference,
      amount: pricing.total.toFixed(2),
      amountType: pricing.currency,
      clientCode: SABPAISA_CONFIG.clientCode,
      transUserName: SABPAISA_CONFIG.transUserName,
      transUserPassword: SABPAISA_CONFIG.transUserPassword,
      callbackUrl,
      channelId: SABPAISA_CONFIG.channelId,
      udf1: match.slug,
      udf2: section.id,
      udf3: String(quantity),
      udf4: String(section.dynamicPrice)
    }).toString();

    let encData;
    try {
      encData = sabpaisaEncryptPayload(
        gatewayPayload,
        SABPAISA_CONFIG.authKey,
        SABPAISA_CONFIG.authIv
      );
    } catch (error) {
      console.error("[sabpaisa] Failed to build encrypted checkout payload", {
        message: error?.message || "Unknown error",
        ...getSabpaisaCryptoMeta(SABPAISA_CONFIG)
      });
      throw new HttpError(502, "Unable to initiate SabPaisa checkout.");
    }

    pendingOrders.set(orderReference, {
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

    res.status(201).json({
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
        gatewayUrl: SABPAISA_CONFIG.urls.gatewayUrl,
        clientCode: SABPAISA_CONFIG.clientCode,
        encData,
        appBaseUrl: SABPAISA_CONFIG.urls.appBaseUrl,
        callbackUrl: SABPAISA_CONFIG.urls.callbackUrl,
        successUrl: SABPAISA_CONFIG.urls.successUrl,
        failureUrl: SABPAISA_CONFIG.urls.failureUrl,
        webhookUrl: SABPAISA_CONFIG.urls.webhookUrl
      }
    });
  })
);

app.all([
  "/api/checkout/sabpaisa/response",
  "/api/payments/sabpaisa/callback",
  "/api/payments/sabpaisa/webhook"
], asyncHandler(async (req, res) => {
  const redirectFailure = (reason) => {
    const target = new URL(SABPAISA_CONFIG.urls.failureUrl);
    target.searchParams.set("payment", "failed");
    target.searchParams.set("reason", asString(reason || "Payment failed."));
    res.redirect(target.toString());
  };

  if (SABPAISA_CONFIG_ERRORS.length > 0) {
    redirectFailure("Invalid SabPaisa configuration on this server.");
    return;
  }

  if (!isSabpaisaConfigured) {
    redirectFailure("SabPaisa is not configured on this server.");
    return;
  }

  const encResponseRaw =
    req.query?.encResponse ||
    req.query?.responseQuery ||
    req.body?.encResponse ||
    req.body?.responseQuery ||
    req.body?.encData ||
    "";

  const encResponse = asString(encResponseRaw).replace(/ /g, "+");
  if (!encResponse) {
    redirectFailure("Missing SabPaisa response payload.");
    return;
  }

  let payload;
  try {
    const decrypted = sabpaisaDecryptPayload(
      encResponse,
      SABPAISA_CONFIG.authKey,
      SABPAISA_CONFIG.authIv
    );
    payload = Object.fromEntries(new URLSearchParams(String(decrypted || "")).entries());
  } catch (error) {
    redirectFailure("Unable to verify SabPaisa response.");
    return;
  }

  const orderReference = asString(
    payload?.clientTxnId || payload?.order_id || payload?.orderReference
  );
  if (!orderReference) {
    redirectFailure("Missing order id in gateway response.");
    return;
  }

  const pending = pendingOrders.get(orderReference);
  if (!pending || pending.mode !== "sabpaisa") {
    redirectFailure("Order session expired. Please retry checkout.");
    return;
  }

  const status = asString(payload?.status || payload?.Status || payload?.order_status).toLowerCase();
  const respCode = asString(payload?.sabPaisaRespCode || payload?.respCode);
  const success =
    status === "success" ||
    status === "successful" ||
    (respCode === "0000" && status !== "failure" && status !== "failed");

  if (!success) {
    pendingOrders.delete(orderReference);
    redirectFailure(`Payment ${status || "failed"}.`);
    return;
  }

  const paidAmount = Number(payload?.paidAmount || payload?.amount || payload?.Amount || 0);
  if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - pending.pricing.total) > 0.01) {
    pendingOrders.delete(orderReference);
    redirectFailure("Amount mismatch in gateway response.");
    return;
  }

  pending.paymentId = asString(payload?.txnId || payload?.transactionId || payload?.bankTxnId || "");

  const finalized = finalizeOrder(orderReference);
  if (!finalized.ok) {
    redirectFailure(finalized.error);
    return;
  }

  const params = buildThankYouParams(finalized);
  const target = new URL(SABPAISA_CONFIG.urls.successUrl);
  target.search = params.toString();
  res.redirect(target.toString());
}));

app.get("/payment/success", (req, res) => {
  const target = new URL("/thankyou.html", getRequestOrigin(req));
  target.search = new URLSearchParams(req.query).toString();
  res.redirect(target.toString());
});

app.get("/payment/failure", (req, res) => {
  const target = new URL("/", getRequestOrigin(req));
  target.search = new URLSearchParams(req.query).toString();
  if (!target.searchParams.has("payment")) {
    target.searchParams.set("payment", "failed");
  }
  res.redirect(target.toString());
});

app.post("/api/checkout/verify", (req, res) => {
  res.status(409).json({
    error: "SabPaisa payments are verified only through /api/checkout/sabpaisa/response callback."
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/see-tickets.html", (req, res) => {
  res.sendFile(path.join(__dirname, "see-tickets.html"));
});

app.get("/thankyou.html", (req, res) => {
  res.sendFile(path.join(__dirname, "thankyou.html"));
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found." });
});

app.use((req, res) => {
  res.status(404).send("Not found");
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ error: "Invalid JSON payload." });
  }

  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const payload = {
    error: error instanceof HttpError ? error.message : "Unexpected server error."
  };

  if (error instanceof HttpError && Array.isArray(error.details) && error.details.length > 0) {
    payload.details = error.details;
  }

  if (!(error instanceof HttpError) && process.env.NODE_ENV !== "production") {
    payload.debug = error.message;
  }

  res.status(statusCode).json(payload);
});

initializeSoldState();
setInterval(cleanupPendingOrders, 60_000).unref();

app.listen(PORT, () => {
  console.log(
    `[server] running on http://localhost:${PORT} | checkout=sabpaisa | env=${SABPAISA_CONFIG.environment} | appBaseUrl=${SABPAISA_CONFIG.urls.appBaseUrl || "unset"} | configured=${isSabpaisaConfigured}`
  );
});
