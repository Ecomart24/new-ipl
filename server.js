"use strict";

const crypto = require("crypto");
const path = require("path");

const dotenv = require("dotenv");
const express = require("express");
const Razorpay = require("razorpay");

const { getAllMatches, getMatchBySlug } = require("./data/matches");

dotenv.config();

const app = express();

const PORT = normalizeInteger(process.env.PORT, 3000, { min: 1, max: 65535 });
const CURRENCY = "INR";
const ORDER_TTL_MS = 30 * 60 * 1000;
const CHECKOUT_PROVIDER = asString(process.env.CHECKOUT_PROVIDER || "razorpay").toLowerCase();
const RAZORPAY_KEY_ID = asString(process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID);
const RAZORPAY_KEY_SECRET = asString(process.env.RAZORPAY_KEY_SECRET);
const MATCH_STATUS_PROVIDER = asString(process.env.MATCH_STATUS_PROVIDER || "fallback");
const LIVE_REFRESH_INTERVAL_MS = normalizeInteger(process.env.MATCH_STATUS_REFRESH_MS, 20000, {
  min: 5000,
  max: 120000
});

const razorpayClient =
  RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET
      })
    : null;

const orderStore = new Map();

app.disable("x-powered-by");
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

function normalizeInteger(value, fallback, options = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (options.min != null && parsed < options.min) {
    return options.min;
  }
  if (options.max != null && parsed > options.max) {
    return options.max;
  }
  return parsed;
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(length = 8) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

function createOrderReference() {
  return `ord_${Date.now()}_${randomId(10)}`;
}

function createBookingId() {
  return `IPL-${Date.now().toString(36).toUpperCase()}-${randomId(6).toUpperCase()}`;
}

function safeSignatureEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function validateBuyer(buyer) {
  const sanitized = {
    name: asString(buyer?.name),
    email: asString(buyer?.email).toLowerCase(),
    phone: asString(buyer?.phone)
  };

  const errors = [];
  if (!sanitized.name || sanitized.name.length < 2) {
    errors.push("buyer.name is required.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitized.email)) {
    errors.push("buyer.email must be valid.");
  }
  if (!/^[0-9+\-\s]{8,15}$/.test(sanitized.phone)) {
    errors.push("buyer.phone must be valid.");
  }

  return { buyer: sanitized, errors };
}

function getMatchPhase(dateTime) {
  const start = new Date(dateTime).getTime();
  const now = Date.now();
  const end = start + 4 * 60 * 60 * 1000;

  if (now < start) {
    return { matchPhase: "Upcoming", matchStatusText: "Scheduled" };
  }
  if (now >= start && now <= end) {
    return { matchPhase: "Running", matchStatusText: "Live now" };
  }
  return { matchPhase: "Completed", matchStatusText: "Match ended" };
}

function getSectionStatus(available, capacity) {
  if (available <= 0) return "Sold Out";
  if (available <= Math.max(25, Math.round(capacity * 0.1))) return "Almost Gone";
  if (available <= Math.round(capacity * 0.25)) return "Limited";
  return "Available";
}

function getMatchInventoryStatus(seatsLeft, totalCapacity) {
  if (seatsLeft <= 0) return "Sold Out";
  if (seatsLeft <= Math.max(100, Math.round(totalCapacity * 0.1))) return "Almost Gone";
  if (seatsLeft <= Math.round(totalCapacity * 0.3)) return "Limited";
  return "Live";
}

function getDynamicPrice(basePrice, capacity, available) {
  const soldRatio = capacity <= 0 ? 1 : (capacity - available) / capacity;
  const surgeMultiplier = 1 + Math.max(0, soldRatio - 0.55) * 0.45;
  return Math.max(100, Math.round((basePrice * surgeMultiplier) / 10) * 10);
}

function hydrateMatch(rawMatch) {
  const sections = rawMatch.sections.map((section) => {
    const available = Math.max(0, section.capacity - section.baseSold);
    const dynamicPrice = getDynamicPrice(section.price, section.capacity, available);
    return {
      ...section,
      available,
      dynamicPrice,
      status: getSectionStatus(available, section.capacity)
    };
  });

  const seatsLeft = sections.reduce((sum, section) => sum + section.available, 0);
  const totalCapacity = sections.reduce((sum, section) => sum + section.capacity, 0);
  const startingPrice = Math.min(...sections.map((section) => section.dynamicPrice));
  const phase = getMatchPhase(rawMatch.dateTime);

  return {
    ...rawMatch,
    sections,
    seatsLeft,
    startingPrice,
    status: getMatchInventoryStatus(seatsLeft, totalCapacity),
    matchPhase: phase.matchPhase,
    matchStatusText: phase.matchStatusText,
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
  return { subtotal, platformFee, gst, total };
}

function resolveCheckoutMode() {
  if (CHECKOUT_PROVIDER === "razorpay") {
    if (razorpayClient) return { mode: "razorpay" };
    return { mode: "demo", fallbackFrom: "razorpay" };
  }

  if (CHECKOUT_PROVIDER === "demo") {
    return { mode: "demo" };
  }

  return { mode: "demo", fallbackFrom: CHECKOUT_PROVIDER };
}

function buildBookingResponse(orderRecord, paymentId) {
  return {
    success: true,
    booking: {
      bookingId: createBookingId(),
      orderReference: orderRecord.orderReference,
      paymentId,
      provider: orderRecord.mode,
      matchSlug: orderRecord.match.slug,
      sectionId: orderRecord.section.id,
      quantity: orderRecord.quantity,
      amount: orderRecord.amount,
      currency: orderRecord.currency,
      buyer: orderRecord.buyer,
      confirmedAt: nowIso()
    }
  };
}

app.get("/api/config", (req, res) => {
  const runtimeCheckout = resolveCheckoutMode();
  res.json({
    checkoutProvider: runtimeCheckout.mode,
    checkoutFallbackFrom: runtimeCheckout.fallbackFrom || null,
    razorpayKeyId: RAZORPAY_KEY_ID || null,
    liveRefreshIntervalMs: LIVE_REFRESH_INTERVAL_MS,
    matchStatusProvider: MATCH_STATUS_PROVIDER,
    currency: CURRENCY
  });
});

app.get("/api/matches", (req, res) => {
  const matches = getHydratedMatches().map((match) => toMatchSummary(match));
  res.json({ matches });
});

app.get("/api/matches/:slug", (req, res, next) => {
  const match = getHydratedMatch(req.params.slug);
  if (!match) {
    return next(new HttpError(404, "Match not found."));
  }
  res.json({ match });
});

app.post(
  "/api/checkout/create-order",
  asyncHandler(async (req, res) => {
    const matchSlug = asString(req.body?.matchSlug);
    const sectionId = asString(req.body?.sectionId);
    const quantity = Number.parseInt(req.body?.quantity, 10);
    const { buyer, errors: buyerErrors } = validateBuyer(req.body?.buyer);

    const validationErrors = [...buyerErrors];

    if (!matchSlug) validationErrors.push("matchSlug is required.");
    if (!sectionId) validationErrors.push("sectionId is required.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 8) {
      validationErrors.push("quantity must be an integer between 1 and 8.");
    }

    if (validationErrors.length > 0) {
      throw new HttpError(400, "Validation failed.", validationErrors);
    }

    const match = getHydratedMatch(matchSlug);
    if (!match) {
      throw new HttpError(404, "Match not found.");
    }

    const section = match.sections.find((item) => item.id === sectionId);
    if (!section) {
      throw new HttpError(404, "Section not found.");
    }

    if (section.available < quantity) {
      throw new HttpError(409, "Not enough seats available for selected section.");
    }

    const pricing = calculatePricing(section.dynamicPrice, quantity);
    const orderReference = createOrderReference();
    const runtimeCheckout = resolveCheckoutMode();

    const baseResponse = {
      mode: runtimeCheckout.mode,
      orderReference,
      match: {
        slug: match.slug,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam
      },
      section: {
        id: section.id,
        label: section.label
      },
      quantity,
      pricing: {
        ...pricing,
        currency: CURRENCY
      }
    };

    if (runtimeCheckout.mode === "razorpay") {
      const amountInPaise = pricing.total * 100;

      let razorpayOrder;
      try {
        razorpayOrder = await razorpayClient.orders.create({
          amount: amountInPaise,
          currency: CURRENCY,
          receipt: orderReference.slice(0, 40),
          notes: {
            orderReference,
            matchSlug: match.slug,
            sectionId: section.id,
            quantity: String(quantity),
            buyerEmail: buyer.email
          }
        });
      } catch (error) {
        throw new HttpError(502, "Failed to create Razorpay order.");
      }

      orderStore.set(orderReference, {
        mode: "razorpay",
        orderReference,
        razorpayOrderId: razorpayOrder.id,
        amount: amountInPaise,
        currency: CURRENCY,
        createdAt: Date.now(),
        buyer,
        quantity,
        match: {
          slug: match.slug
        },
        section: {
          id: section.id
        }
      });

      return res.status(201).json({
        ...baseResponse,
        razorpay: {
          keyId: RAZORPAY_KEY_ID,
          orderId: razorpayOrder.id,
          amount: razorpayOrder.amount,
          currency: razorpayOrder.currency
        }
      });
    }

    orderStore.set(orderReference, {
      mode: "demo",
      orderReference,
      amount: pricing.total * 100,
      currency: CURRENCY,
      createdAt: Date.now(),
      buyer,
      quantity,
      match: {
        slug: match.slug
      },
      section: {
        id: section.id
      }
    });

    return res.status(201).json({
      ...baseResponse,
      ...(runtimeCheckout.fallbackFrom
        ? {
            fallback: {
              from: runtimeCheckout.fallbackFrom,
              to: "demo"
            }
          }
        : {})
    });
  })
);

app.post(
  "/api/checkout/verify",
  asyncHandler(async (req, res) => {
    const orderReference = asString(req.body?.orderReference);
    if (!orderReference) {
      throw new HttpError(400, "orderReference is required.");
    }

    const orderRecord = orderStore.get(orderReference);
    if (!orderRecord) {
      throw new HttpError(404, "Order reference not found or expired.");
    }

    if (Date.now() - orderRecord.createdAt > ORDER_TTL_MS) {
      orderStore.delete(orderReference);
      throw new HttpError(410, "Order reference has expired.");
    }

    if (orderRecord.mode === "razorpay") {
      const razorpayOrderId = asString(req.body?.razorpay_order_id);
      const razorpayPaymentId = asString(req.body?.razorpay_payment_id);
      const razorpaySignature = asString(req.body?.razorpay_signature);

      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        throw new HttpError(400, "Razorpay verification fields are required.");
      }

      if (razorpayOrderId !== orderRecord.razorpayOrderId) {
        throw new HttpError(400, "Razorpay order id does not match.");
      }

      const expectedSignature = crypto
        .createHmac("sha256", RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest("hex");

      if (!safeSignatureEquals(expectedSignature, razorpaySignature)) {
        throw new HttpError(400, "Invalid payment signature.");
      }

      orderStore.delete(orderReference);
      return res.json(buildBookingResponse(orderRecord, razorpayPaymentId));
    }

    const demoTransactionId = asString(req.body?.demoTransactionId);
    if (!demoTransactionId) {
      throw new HttpError(400, "demoTransactionId is required for demo checkout.");
    }

    orderStore.delete(orderReference);
    return res.json(buildBookingResponse(orderRecord, demoTransactionId));
  })
);

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
  const message =
    error instanceof HttpError ? error.message : "Unexpected server error.";
  const payload = { error: message };

  if (error instanceof HttpError && Array.isArray(error.details) && error.details.length > 0) {
    payload.details = error.details;
  }

  if (process.env.NODE_ENV !== "production" && !(error instanceof HttpError)) {
    payload.debug = error.message;
  }

  res.status(statusCode).json(payload);
});

setInterval(() => {
  const now = Date.now();
  for (const [orderReference, order] of orderStore.entries()) {
    if (now - order.createdAt > ORDER_TTL_MS) {
      orderStore.delete(orderReference);
    }
  }
}, 5 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`[server] running on http://localhost:${PORT}`);
});
