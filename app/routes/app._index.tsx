import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit, useNavigation } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Badge, Select, Grid, Button, Divider, List, Box } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { TitleBar } from "@shopify/app-bridge-react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get("days") || "7", 10);
  const dateLimit = new Date();
  dateLimit.setDate(dateLimit.getDate() - days);

  // Fetch Events for the shop within the date limit
  // Try-catch protects against Prisma client caching issues during dev server restarts
  let events: Array<{
    eventType: string;
    sessionId: string;
    metadata: unknown;
  }> = [];
  try {
    events = await db.event.findMany({
      where: {
        shopId: shop,
        createdAt: { gte: dateLimit }
      }
    });
  } catch (err) {
    console.error("[Dashboard] Failed to query events (Prisma client may be stale):", err);
  }

  // 1. KPI Counts
  let opens = 0;
  let messages = 0;
  let images = 0;
  let productClicks = 0;
  let atcClicks = 0;
  const conversationSessions = new Set<string>();

  // Insights tracking
  const clickedProducts: Record<string, { count: number, title: string, handle?: string }> = {};
  const atcProducts: Record<string, { count: number, title: string }> = {};
  const keywords: Record<string, number> = {};

  const stopWords = new Set(["i", "me", "my", "we", "our", "you", "your", "he", "him", "his", "she", "her", "it", "its", "they", "them", "their", "what", "which", "who", "whom", "this", "that", "these", "those", "am", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "having", "do", "does", "did", "doing", "a", "an", "the", "and", "but", "if", "or", "because", "as", "until", "while", "of", "at", "by", "for", "with", "about", "against", "between", "into", "through", "during", "before", "after", "above", "below", "to", "from", "up", "down", "in", "out", "on", "off", "over", "under", "again", "further", "then", "once", "here", "there", "when", "where", "why", "how", "all", "any", "both", "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "can", "will", "just", "don", "should", "now", "looking", "want", "need", "for", "any", "some", "do"]);

  for (const ev of events) {
    if (ev.eventType === "widget_opened") opens++;
    if (ev.eventType === "message_sent") {
      messages++;
      conversationSessions.add(ev.sessionId);

      // Extract keywords
      const text = (ev.metadata as any)?.text;
      if (typeof text === "string") {
        const words = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/);
        for (const w of words) {
          if (w.length > 2 && !stopWords.has(w)) {
            keywords[w] = (keywords[w] || 0) + 1;
          }
        }
      }
    }
    if (ev.eventType === "image_uploaded") images++;
    if (ev.eventType === "product_clicked") {
      productClicks++;
      const handle = (ev.metadata as any)?.handle || "unknown";
      const title = (ev.metadata as any)?.title || handle;
      if (!clickedProducts[handle]) clickedProducts[handle] = { count: 0, title, handle };
      clickedProducts[handle].count++;
    }
    if (ev.eventType === "add_to_cart_clicked") {
      atcClicks++;
      const variantId = (ev.metadata as any)?.variantId || "unknown";
      const title = (ev.metadata as any)?.title || "Product";
      if (!atcProducts[variantId]) atcProducts[variantId] = { count: 0, title };
      atcProducts[variantId].count++;
    }
  }

  const conversations = conversationSessions.size;
  const engagementRate = opens > 0 ? Math.round((conversations / opens) * 100) : 0;

  // Sorting Insights
  const topClicked = Object.values(clickedProducts).sort((a, b) => b.count - a.count).slice(0, 5);
  const topAtc = Object.values(atcProducts).sort((a, b) => b.count - a.count).slice(0, 5);
  const topKeywords = Object.entries(keywords).map(([word, freq]) => ({ word, freq })).sort((a, b) => b.freq - a.freq).slice(0, 10);

  // Funnel Conversions
  const funnelSessions = {
    opens: new Set<string>(),
    convos: new Set<string>(),
    clicks: new Set<string>(),
    atcs: new Set<string>()
  };

  for (const ev of events) {
    if (ev.eventType === "widget_opened") funnelSessions.opens.add(ev.sessionId);
    if (ev.eventType === "message_sent") funnelSessions.convos.add(ev.sessionId);
    if (ev.eventType === "product_clicked") funnelSessions.clicks.add(ev.sessionId);
    if (ev.eventType === "add_to_cart_clicked") funnelSessions.atcs.add(ev.sessionId);
  }
  const fOpens = funnelSessions.opens.size;
  const fConvos = funnelSessions.convos.size;
  const fClicks = funnelSessions.clicks.size;
  const fAtcs = funnelSessions.atcs.size;

  const Drop1 = fOpens > 0 ? Math.round((fConvos / fOpens) * 100) : 0;
  const Drop2 = fConvos > 0 ? Math.round((fClicks / fConvos) * 100) : 0;
  const Drop3 = fClicks > 0 ? Math.round((fAtcs / fClicks) * 100) : 0;

  // Catalog Health
  const productCount = await db.product.count({ where: { shopDomain: shop } });
  const lastSync = await db.syncLog.findFirst({
    where: { shopDomain: shop },
    orderBy: { startedAt: "desc" }
  });

  return json({
    days,
    kpis: { opens, conversations, messages, images, productClicks, atcClicks, engagementRate },
    funnel: {
      opens: fOpens, convos: fConvos, clicks: fClicks, atcs: fAtcs,
      convRates: { drop1: Drop1, drop2: Drop2, drop3: Drop3 }
    },
    insights: { topClicked, topAtc, topKeywords },
    catalog: {
      productCount,
      lastSyncedAt: lastSync?.completedAt || lastSync?.startedAt || null,
      lastSyncCount: lastSync?.productCount || 0,
      lastSyncError: lastSync?.error || null,
      status: lastSync?.status || "NEVER_SYNCED"
    }
  });
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();

  const handleDaysChange = (value: string) => {
    submit({ days: value }, { method: "get" });
  };

  const isSyncing = navigation.state === "submitting" && navigation.formAction === "/app/catalog";

  return (
    <Page
      title="Dashboard Overview"
      primaryAction={{ content: "Billing", onAction: () => navigate("/app/billing") }}
    >
      <TitleBar title="Dashboard" />
      <BlockStack gap="500">
        {/* Header Controls */}
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="headingLg" as="h1">Performance Analytics</Text>
          <Select
            label="Date range"
            labelInline
            options={[
              { label: "Last 7 days", value: "7" },
              { label: "Last 30 days", value: "30" },
            ]}
            value={String(data.days)}
            onChange={handleDaysChange}
          />
        </InlineStack>

        {/* KPIs */}
        <Grid>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Widget Opens</Text>
                <Text as="p" variant="headingXl">{data.kpis.opens}</Text>
              </BlockStack>
            </Card>
          </Grid.Cell>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Conversations</Text>
                <Text as="p" variant="headingXl">{data.kpis.conversations}</Text>
                <Text as="p" variant="bodySm" tone="subdued">{data.kpis.engagementRate}% Engagement Rate</Text>
              </BlockStack>
            </Card>
          </Grid.Cell>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Total Messages</Text>
                <Text as="p" variant="headingXl">{data.kpis.messages}</Text>
                <Text as="p" variant="bodySm" tone="subdued">{data.kpis.images} images uploaded</Text>
              </BlockStack>
            </Card>
          </Grid.Cell>
          <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
            <Card padding="400">
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">Product Clicks</Text>
                <Text as="p" variant="headingXl">{data.kpis.productClicks}</Text>
                <Text as="p" variant="bodySm" tone="subdued">{data.kpis.atcClicks} Add-to-Carts</Text>
              </BlockStack>
            </Card>
          </Grid.Cell>
        </Grid>

        {/* Conversion Funnel */}
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">Conversion Funnel (Unique Sessions)</Text>
            <InlineStack align="space-around" blockAlign="center" wrap={false}>
              <BlockStack align="center" inlineAlign="center" gap="200">
                <Text as="p" variant="headingLg">{data.funnel.opens}</Text>
                <Text as="p" tone="subdued">Opens</Text>
              </BlockStack>
              <BlockStack align="center" gap="100">
                <Text as="p" variant="bodySm" tone="success">{data.funnel.convRates.drop1}%</Text>
                <Text as="span" tone="subdued">→</Text>
              </BlockStack>

              <BlockStack align="center" inlineAlign="center" gap="200">
                <Text as="p" variant="headingLg">{data.funnel.convos}</Text>
                <Text as="p" tone="subdued">Convos</Text>
              </BlockStack>
              <BlockStack align="center" gap="100">
                <Text as="p" variant="bodySm" tone="success">{data.funnel.convRates.drop2}%</Text>
                <Text as="span" tone="subdued">→</Text>
              </BlockStack>

              <BlockStack align="center" inlineAlign="center" gap="200">
                <Text as="p" variant="headingLg">{data.funnel.clicks}</Text>
                <Text as="p" tone="subdued">Clicks</Text>
              </BlockStack>
              <BlockStack align="center" gap="100">
                <Text as="p" variant="bodySm" tone="success">{data.funnel.convRates.drop3}%</Text>
                <Text as="span" tone="subdued">→</Text>
              </BlockStack>

              <BlockStack align="center" inlineAlign="center" gap="200">
                <Text as="p" variant="headingLg">{data.funnel.atcs}</Text>
                <Text as="p" tone="subdued">Add to Carts</Text>
              </BlockStack>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Insights Row */}
        <Grid>
          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Top Customer Intents</Text>
                <Divider />
                {data.insights.topKeywords.length === 0 ? (
                  <Text as="p" tone="subdued">Not enough data yet.</Text>
                ) : (
                  <List type="number">
                    {data.insights.topKeywords.map(k => (
                      <List.Item key={k.word}>
                        <InlineStack align="space-between">
                          <Text as="span" fontWeight="bold">{k.word}</Text>
                          <Badge>{`${k.freq} mentions`}</Badge>
                        </InlineStack>
                      </List.Item>
                    ))}
                  </List>
                )}
              </BlockStack>
            </Card>
          </Grid.Cell>
          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Top Clicked Products</Text>
                <Divider />
                {data.insights.topClicked.length === 0 ? (
                  <Text as="p" tone="subdued">No product clicks yet.</Text>
                ) : (
                  <List type="bullet">
                    {data.insights.topClicked.map(p => (
                      <List.Item key={p.handle}>
                        <InlineStack align="space-between">
                          <Text as="span">{p.title}</Text>
                          <Badge tone="info">{`${p.count} clicks`}</Badge>
                        </InlineStack>
                      </List.Item>
                    ))}
                  </List>
                )}
              </BlockStack>
            </Card>
          </Grid.Cell>
          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Top Add-to-Carts</Text>
                <Divider />
                {data.insights.topAtc.length === 0 ? (
                  <Text as="p" tone="subdued">No add-to-carts yet.</Text>
                ) : (
                  <List type="bullet">
                    {data.insights.topAtc.map(p => (
                      <List.Item key={p.title}>
                        <InlineStack align="space-between">
                          <Text as="span">{p.title}</Text>
                          <Badge tone="success">{`${p.count} ATC`}</Badge>
                        </InlineStack>
                      </List.Item>
                    ))}
                  </List>
                )}
              </BlockStack>
            </Card>
          </Grid.Cell>
        </Grid>

        {/* Catalog Health */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">Catalog Health</Text>
              <form action="/app/catalog" method="POST">
                <Button submit loading={isSyncing} variant="primary">Sync now</Button>
              </form>
            </InlineStack>
            <Divider />
            <InlineStack gap="800">
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm" tone="subdued">Synced Products</Text>
                <Text as="p" variant="headingXl">{data.catalog.productCount}</Text>
              </BlockStack>
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm" tone="subdued">Last Sync Status</Text>
                <Badge tone={data.catalog.status === "SUCCESS" ? "success" : data.catalog.status === "FAILED" ? "critical" : "info"}>
                  {data.catalog.status}
                </Badge>
                {data.catalog.lastSyncedAt && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {new Date(data.catalog.lastSyncedAt).toLocaleString()}
                  </Text>
                )}
              </BlockStack>
            </InlineStack>
          </BlockStack>
        </Card>

      </BlockStack>
    </Page>
  );
}
