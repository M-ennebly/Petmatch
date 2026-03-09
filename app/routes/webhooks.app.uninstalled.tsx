import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook() verifies the HMAC signature using SHOPIFY_API_SECRET
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`[Webhook] Received ${topic} for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // Guard against missing shop domain.
  if (!shop) {
    console.log("[Webhook] No shop domain in payload, skipping.");
    return new Response();
  }

  // ── 1. Look up shop in DB ──────────────────────────────────────────────────
  const shopRecord = await db.shop.findUnique({
    where: { domain: shop },
    include: { merchantSettings: true },
  });

  if (shopRecord) {
    // ── 2. Mark shop as UNINSTALLED (soft-delete) ────────────────────────────
    await db.shop.update({
      where: { id: shopRecord.id },
      data: {
        status: "UNINSTALLED",
        uninstalledAt: new Date(),
        scriptTagId: null, // Shopify auto-removes ScriptTags on uninstall
      },
    });
    console.log(`[Webhook] Shop ${shop} marked as UNINSTALLED`);

    // ── 3. Disable widget ────────────────────────────────────────────────────
    if (shopRecord.merchantSettings) {
      await db.merchantSettings.update({
        where: { shopId: shopRecord.id },
        data: { isActive: false },
      });
      console.log(`[Webhook] MerchantSettings.isActive set to false for ${shop}`);
    }
  } else {
    console.log(`[Webhook] Shop ${shop} not found in DB, skipping cleanup.`);
  }

  // ── 4. Delete all sessions for this shop ───────────────────────────────────
  if (session) {
    await db.session.deleteMany({ where: { shop } });
    console.log(`[Webhook] Sessions deleted for ${shop}`);
  }

  return new Response();
};
