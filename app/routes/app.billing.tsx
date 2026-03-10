import { json, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Badge, Button, Divider, ProgressBar, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { TitleBar } from "@shopify/app-bridge-react";
import { getShopPlan, getMonthlyUsage } from "../lib/billing.server";
import { PLANS } from "../lib/billing.shared";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { session } = await authenticate.admin(request);
    const shopDomain = session.shop;
    const [plan, usage] = await Promise.all([
        getShopPlan(shopDomain),
        getMonthlyUsage(shopDomain),
    ]);
    return json({ plan, usage, plans: PLANS });
};

export const action = async ({ request }: ActionFunctionArgs) => {
    const { session, billing } = await authenticate.admin(request);
    const shopDomain = session.shop;
    const formData = await request.formData();
    const targetPlan = formData.get("plan") as string;

    if (targetPlan === "FREE") {
        // Cancel existing subscription
        const activeSub = await db.subscription.findUnique({ where: { shopDomain } });
        if (activeSub?.shopifyChargeId) {
            await billing.cancel({ subscriptionId: activeSub.shopifyChargeId, isTest: true, prorate: true });
        }
        await db.subscription.upsert({
            where: { shopDomain },
            update: { plan: "FREE", status: "ACTIVE", shopifyChargeId: null },
            create: { shopDomain, plan: "FREE", status: "ACTIVE" },
        });
        return redirect("/app/billing");
    }

    const planDetails = PLANS[targetPlan as keyof typeof PLANS];
    if (!planDetails || planDetails.price === 0) {
        return json({ error: "Invalid plan" }, { status: 400 });
    }

    const confirmationUrl = await billing.request({
        plan: planDetails.name,
        isTest: true, // Remove this in production
        returnUrl: `${new URL(request.url).origin}/app/billing/confirm?plan=${targetPlan}`,
    });

    return redirect(confirmationUrl as string);
};

export default function Billing() {
    const { plan, usage, plans } = useLoaderData<typeof loader>();
    const fetcher = useFetcher();
    const navigate = useNavigate();

    const currentPlan = plans[plan as keyof typeof plans];
    const messageLimit = currentPlan.monthlyMessageLimit;
    const messagePercent = messageLimit === -1 ? 0 : Math.min((usage.messages / messageLimit) * 100, 100);
    const isNearLimit = messageLimit !== -1 && messagePercent >= 80;

    return (
        <Page
            title="Billing & Plans"
            backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
        >
            <TitleBar title="Billing & Plans" />
            <Layout>
                {isNearLimit && (
                    <Layout.Section>
                        <Banner tone="warning" title="You're approaching your message limit">
                            <p>You've used {usage.messages} of {messageLimit} messages this month. Upgrade to avoid interruptions.</p>
                        </Banner>
                    </Layout.Section>
                )}

                {/* Current Usage */}
                <Layout.Section>
                    <Card>
                        <BlockStack gap="400">
                            <InlineStack align="space-between" blockAlign="center">
                                <BlockStack gap="100">
                                    <Text variant="headingMd" as="h2">Current Plan</Text>
                                    <InlineStack gap="200" blockAlign="center">
                                        <Text variant="headingXl" as="h1">{currentPlan.name}</Text>
                                        <Badge tone={plan === "FREE" ? "info" : plan === "GROWTH" ? "success" : "attention"}>
                                            {plan === "FREE" ? "Free" : `$${currentPlan.price}/mo`}
                                        </Badge>
                                    </InlineStack>
                                </BlockStack>
                            </InlineStack>
                            <Divider />
                            <BlockStack gap="200">
                                <Text variant="headingSm" as="h3">Monthly Usage</Text>
                                <InlineStack align="space-between">
                                    <Text as="p">Messages</Text>
                                    <Text as="p">{usage.messages} / {messageLimit === -1 ? "Unlimited" : messageLimit}</Text>
                                </InlineStack>
                                {messageLimit !== -1 && <ProgressBar progress={messagePercent} tone={isNearLimit ? "critical" : "primary"} />}
                            </BlockStack>
                        </BlockStack>
                    </Card>
                </Layout.Section>

                {/* Plan Cards */}
                <Layout.Section>
                    <Text variant="headingMd" as="h2">Available Plans</Text>
                </Layout.Section>

                {(["FREE", "GROWTH", "PRO"] as const).map((planKey) => {
                    const p = plans[planKey];
                    const isCurrent = plan === planKey;
                    return (
                        <Layout.Section key={planKey}>
                            <Card>
                                <BlockStack gap="300">
                                    <InlineStack align="space-between" blockAlign="center">
                                        <BlockStack gap="100">
                                            <InlineStack gap="200" blockAlign="center">
                                                <Text variant="headingMd" as="h3">{p.name}</Text>
                                                {isCurrent && <Badge tone="success">Current</Badge>}
                                            </InlineStack>
                                            <Text variant="headingLg" as="p">
                                                {p.price === 0 ? "Free" : `$${p.price}/month`}
                                            </Text>
                                        </BlockStack>
                                        {!isCurrent && (
                                            <fetcher.Form method="post">
                                                <input type="hidden" name="plan" value={planKey} />
                                                <Button
                                                    variant={planKey === "PRO" ? "primary" : "secondary"}
                                                    submit
                                                    loading={fetcher.state === "submitting"}
                                                >
                                                    {plan === "FREE" || PLANS[plan].price < p.price ? "Upgrade" : "Downgrade"}
                                                </Button>
                                            </fetcher.Form>
                                        )}
                                    </InlineStack>
                                    <Divider />
                                    <BlockStack gap="200">
                                        <Text as="p">✓ {p.monthlyMessageLimit === -1 ? "Unlimited" : p.monthlyMessageLimit.toLocaleString()} messages/month</Text>
                                        <Text as="p">✓ {p.productLimit === -1 ? "Unlimited" : p.productLimit} products in catalog</Text>
                                        <Text as="p" tone={p.hasCustomBranding ? undefined : "subdued"}>
                                            {p.hasCustomBranding ? "✓" : "✗"} Custom branding
                                        </Text>
                                        <Text as="p" tone={p.hasAnalytics ? undefined : "subdued"}>
                                            {p.hasAnalytics ? "✓" : "✗"} Analytics
                                        </Text>
                                    </BlockStack>
                                </BlockStack>
                            </Card>
                        </Layout.Section>
                    );
                })}
            </Layout>
        </Page>
    );
}
