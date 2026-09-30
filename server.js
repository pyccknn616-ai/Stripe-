// Stripe Connect marketplace backend (TEST MODE). Run: npm install && node server.js
// Needs env: STRIPE_SECRET_KEY (sk_test_...), optional BASE_URL, PLATFORM_FEE_PCT
const express = require("express");
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const BASE = process.env.BASE_URL || "http://localhost:3000";
const FEE = Number(process.env.PLATFORM_FEE_PCT || 10) / 100;

const app = express();
app.use(express.json());

// In-memory stores. Swap for a real database before going live.
const workers = {}; // id -> { name, email, stripeAccount }
const jobs = {};    // id -> { title, company, amount (cents), workerId, status, transferGroup, paymentIntent }

// 1) Create a worker as a connected account (recipient) and return an onboarding link.
app.post("/workers", async (req, res) => {
  try {
    const { name, email } = req.body;
    const account = await stripe.v2.core.accounts.create({
      display_name: name,
      contact_email: email,
      identity: { country: "us" },
      dashboard: "express",
      defaults: {
        responsibilities: { fees_collector: "application", losses_collector: "application" },
      },
      configuration: {
        recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
      },
    });
    const id = "w_" + Date.now();
    workers[id] = { name, email, stripeAccount: account.id };
    res.json({ workerId: id, onboardingUrl: await onboardingLink(account.id, id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

async function onboardingLink(account, workerId) {
  const link = await stripe.v2.core.accountLinks.create({
    account,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        configurations: ["recipient"],
        refresh_url: `${BASE}/workers/${workerId}/onboarding`,
        return_url: `${BASE}/?onboarded=${workerId}`,
      },
    },
  });
  return link.url;
}

// New onboarding link (used when a link expires or the worker leaves midway)
app.get("/workers/:id/onboarding", async (req, res) => {
  const w = workers[req.params.id];
  if (!w) return res.status(404).json({ error: "unknown worker" });
  res.redirect(await onboardingLink(w.stripeAccount, req.params.id));
});

// Can this worker receive money yet?
app.get("/workers/:id/status", async (req, res) => {
  const w = workers[req.params.id];
  if (!w) return res.status(404).json({ error: "unknown worker" });
  const a = await stripe.v2.core.accounts.retrieve(w.stripeAccount, { include: ["configuration.recipient"] });
  const status = a.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status;
  res.json({ transfersEnabled: status === "active", status });
});

// 2) Company creates a job and pays for it (funds are held on your platform balance).
app.post("/jobs", (req, res) => {
  const { title, company, amountUsd, workerId } = req.body;
  const id = "j_" + Date.now();
  jobs[id] = { title, company, amount: Math.round(amountUsd * 100), workerId, status: "awaiting_payment", transferGroup: id };
  res.json({ jobId: id });
});

app.post("/jobs/:id/checkout", async (req, res) => {
  try {
    const j = jobs[req.params.id];
    if (!j) return res.status(404).json({ error: "unknown job" });
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: j.amount, product_data: { name: j.title } } }],
      payment_intent_data: { transfer_group: j.transferGroup },
      metadata: { jobId: req.params.id },
      success_url: `${BASE}/?paid=${req.params.id}`,
      cancel_url: `${BASE}/`,
    });
    res.json({ checkoutUrl: session.url });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Mark paid after Stripe confirms (webhook). Set up in Stripe: checkout.session.completed -> /webhook
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  // NOTE: express.json() above already parsed the body; mount this route BEFORE app.use(express.json())
  // in production and verify with stripe.webhooks.constructEvent + STRIPE_WEBHOOK_SECRET.
  res.sendStatus(200);
});
app.post("/jobs/:id/mark-paid", async (req, res) => { // test-mode helper until the webhook is wired
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ error: "unknown job" });
  const sessions = await stripe.checkout.sessions.list({ limit: 20 });
  const s = sessions.data.find((x) => x.metadata?.jobId === req.params.id && x.payment_status === "paid");
  if (!s) return res.status(400).json({ error: "not paid yet" });
  j.paymentIntent = s.payment_intent;
  j.status = "paid";
  res.json({ status: j.status });
});

// 3) Job complete -> release payout to the worker, keeping your fee.
app.post("/jobs/:id/complete", async (req, res) => {
  try {
    const j = jobs[req.params.id];
    if (!j || j.status !== "paid") return res.status(400).json({ error: "job not paid" });
    const w = workers[j.workerId];
    const pi = await stripe.paymentIntents.retrieve(j.paymentIntent);
    const payout = Math.round(j.amount * (1 - FEE));
    const t = await stripe.transfers.create({
      amount: payout, currency: "usd", destination: w.stripeAccount,
      transfer_group: j.transferGroup, source_transaction: pi.latest_charge,
    });
    j.status = "completed";
    res.json({ status: j.status, transferId: t.id, workerGets: payout / 100, platformKeeps: (j.amount - payout) / 100 });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3000, () => console.log("Connect server up (test mode)"));
