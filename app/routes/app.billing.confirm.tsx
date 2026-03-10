import { type LoaderFunctionArgs, redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { session, billing } = await authenticate.admin(request);
    const shopDomain = session.shop;
    const url = new URL(request.url);
    const plan = url.searchParams.get("plan") || "FREE";

    const billingCheck = await billing.check({ plans: ["Growth", "Pro"], isTest: true });
    const activeSubscription = billingCheck.appSubscriptions?.[0];

    if (activeSubscription) {
        await db.subscription.upsert({
            where: { shopDomain },
            update: {
                plan: plan.toUpperCase(),
                status: "ACTIVE",
                shopifyChargeId: activeSubscription.id,
            },
            create: {
                shopDomain,
                plan: plan.toUpperCase(),
                status: "ACTIVE",
                shopifyChargeId: activeSubscription.id,
            },
        });
    }

    return redirect("/app/billing");
};
