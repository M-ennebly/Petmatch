import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Badge, Button, Divider, ProgressBar } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { TitleBar } from "@shopify/app-bridge-react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;

    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const mtdEvents = await db.event.findMany({
        where: {
            shopId: shop,
            createdAt: { gte: firstDayOfMonth },
            eventType: {
                in: ["message_sent", "image_uploaded"]
            }
        }
    });

    let messages = 0;
    let images = 0;
    for (const ev of mtdEvents) {
        if (ev.eventType === "message_sent") messages++;
        if (ev.eventType === "image_uploaded") images++;
    }

    return json({ messages, images });
};

export default function Billing() {
    const data = useLoaderData<typeof loader>();
    const navigate = useNavigate();

    return (
        <Page
            title="Billing & Plans"
            backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
        >
            <TitleBar title="Billing" />
            <Layout>
                <Layout.Section>
                    <Card padding="400">
                        <BlockStack gap="400">
                            <InlineStack align="space-between" blockAlign="center">
                                <BlockStack gap="100">
                                    <Text variant="headingXl" as="h1">Free Plan</Text>
                                    <Text as="p" tone="subdued">You are currently on the free trial.</Text>
                                </BlockStack>
                                <Button variant="primary" size="large" onClick={() => { }}>Upgrade</Button>
                            </InlineStack>

                            <Divider />

                            <Text variant="headingMd" as="h2">Month-to-Date Usage</Text>

                            <BlockStack gap="200">
                                <InlineStack align="space-between">
                                    <Text as="p">Messages Sent</Text>
                                    <Text as="span" fontWeight="bold">{data.messages}</Text>
                                </InlineStack>
                            </BlockStack>

                            <BlockStack gap="200">
                                <InlineStack align="space-between">
                                    <Text as="p">Images Uploaded</Text>
                                    <Text as="span" fontWeight="bold">{data.images}</Text>
                                </InlineStack>
                            </BlockStack>
                        </BlockStack>
                    </Card>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
