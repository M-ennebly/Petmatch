import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit, useNavigation } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Badge, Button, Divider, List, Box, Grid, Select, Icon } from "@shopify/polaris";
import { ViewIcon, ChatIcon, SendIcon, CartIcon, TargetIcon, ProductIcon } from '@shopify/polaris-icons';
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

  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <Page title="Performance Hub" primaryAction={{ content: "View Settings", onAction: () => navigate("/app/settings") }}>
      <TitleBar title="Dashboard" />
      <BlockStack gap="800">

        {/* Clean Header & Controls */}
        <InlineStack align="space-between" blockAlign="end">
          <BlockStack gap="100">
            <Text variant="headingXl" as="h1" fontWeight="regular">Good {timeOfDay}, here's how Lumi is performing</Text>
            <Text variant="bodyMd" tone="subdued" as="p">{today}</Text>
          </BlockStack>
          <InlineStack gap="300" blockAlign="center">
            <div style={{ width: '200px' }}>
              <Select
                label="Date range"
                labelHidden
                options={[
                  { label: "Last 7 days", value: "7" },
                  { label: "Last 30 days", value: "30" },
                ]}
                value={String(data.days)}
                onChange={handleDaysChange}
              />
            </div>
          </InlineStack>
        </InlineStack>

        {/* Minimalist KPIs Grid */}
        <InlineStack gap="400" blockAlign="stretch" wrap={true}>
          <div style={{ flex: '1 1 220px' }}>
            <Card padding="400">
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h3" variant="bodyMd" tone="subdued">Widget Opens</Text>
                  <Icon source={ViewIcon} tone="base" />
                </InlineStack>
                <BlockStack gap="100">
                  <Text as="p" variant="headingXl" fontWeight="medium">{String(data.kpis.opens)}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">Initial visits</Text>
                </BlockStack>
              </BlockStack>
            </Card>
          </div>

          <div style={{ flex: '1 1 220px' }}>
            <Card padding="400">
              <BlockStack gap="400">
                <Text as="h3" variant="bodyMd" tone="subdued">Conversations started</Text>
                <BlockStack gap="100">
                  <Text as="p" variant="headingXl" fontWeight="medium">{String(data.kpis.conversations)}</Text>
                  <Text as="p" variant="bodySm" tone="success">{data.kpis.engagementRate}% Engagement Rate</Text>
                </BlockStack>
              </BlockStack>
            </Card>
          </div>

          <div style={{ flex: '1 1 220px' }}>
            <Card padding="400">
              <BlockStack gap="400">
                <Text as="h3" variant="bodyMd" tone="subdued">Product details sent</Text>
                <BlockStack gap="100">
                  <Text as="p" variant="headingXl" fontWeight="medium">{String(data.kpis.productClicks)}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">Recommendations viewed</Text>
                </BlockStack>
              </BlockStack>
            </Card>
          </div>

          <div style={{ flex: '1 1 220px' }}>
            <Card padding="400">
              <BlockStack gap="400">
                <Text as="h3" variant="bodyMd" tone="subdued">Add to carts</Text>
                <BlockStack gap="100">
                  <Text as="p" variant="headingXl" fontWeight="medium">{String(data.kpis.atcClicks)}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">Attributed actions</Text>
                </BlockStack>
              </BlockStack>
            </Card>
          </div>
        </InlineStack>

        {/* Clean Conversion Funnel */}
        <Card padding="500">
          <BlockStack gap="500">
            <Text variant="headingMd" as="h2">Conversion Funnel</Text>

            {data.funnel.opens === 0 ? (
              <Box paddingBlockStart="400" paddingBlockEnd="400">
                <BlockStack inlineAlign="center" gap="200">
                  <div style={{ width: '32px', height: '32px', color: '#5c6ac4' }}>
                    <Icon source={TargetIcon} />
                  </div>
                  <Text as="p" tone="subdued" variant="bodyMd" alignment="center">Wait for customers to open the widget.<br />Their journey steps will appear here.</Text>
                </BlockStack>
              </Box>
            ) : (
              <div style={{ backgroundColor: '#f9fafa', borderRadius: '8px', padding: '32px 24px', border: '1px solid #ebebeb' }}>
                <InlineStack align="space-around" blockAlign="center" wrap={false}>
                  {/* Step 1 */}
                  <BlockStack align="center" inlineAlign="center" gap="100">
                    <Text variant="headingLg" as="p" fontWeight="medium">{String(data.funnel.opens)}</Text>
                    <Text tone="subdued" variant="bodySm" as="p">Opens</Text>
                  </BlockStack>

                  {/* Drop 1 */}
                  <BlockStack align="center" gap="0">
                    <Text as="span" tone="success" variant="bodyXs">{data.funnel.convRates.drop1}%</Text>
                    <div style={{ height: '2px', width: '32px', backgroundColor: '#d4d4d4', margin: '4px 0', borderRadius: '2px' }} />
                  </BlockStack>

                  {/* Step 2 */}
                  <BlockStack align="center" inlineAlign="center" gap="100">
                    <Text variant="headingLg" as="p" fontWeight="medium">{String(data.funnel.convos)}</Text>
                    <Text tone="subdued" variant="bodySm" as="p">Chats</Text>
                  </BlockStack>

                  {/* Drop 2 */}
                  <BlockStack align="center" gap="0">
                    <Text as="span" tone="success" variant="bodyXs">{data.funnel.convRates.drop2}%</Text>
                    <div style={{ height: '2px', width: '32px', backgroundColor: '#d4d4d4', margin: '4px 0', borderRadius: '2px' }} />
                  </BlockStack>

                  {/* Step 3 */}
                  <BlockStack align="center" inlineAlign="center" gap="100">
                    <Text variant="headingLg" as="p" fontWeight="medium">{String(data.funnel.clicks)}</Text>
                    <Text tone="subdued" variant="bodySm" as="p">Clicks</Text>
                  </BlockStack>

                  {/* Drop 3 */}
                  <BlockStack align="center" gap="0">
                    <Text as="span" tone="success" variant="bodyXs">{data.funnel.convRates.drop3}%</Text>
                    <div style={{ height: '2px', width: '32px', backgroundColor: '#d4d4d4', margin: '4px 0', borderRadius: '2px' }} />
                  </BlockStack>

                  {/* Step 4 */}
                  <BlockStack align="center" inlineAlign="center" gap="100">
                    <Text variant="headingLg" as="p" fontWeight="medium">{String(data.funnel.atcs)}</Text>
                    <Text tone="subdued" variant="bodySm" as="p">ATCs</Text>
                  </BlockStack>
                </InlineStack>
              </div>
            )}
          </BlockStack>
        </Card>

        {/* Clean Insights Row */}
        <InlineStack gap="400" blockAlign="stretch" wrap={false} align="space-between">
          <div style={{ flex: 1, minWidth: '30%' }}>
            <Card padding="500">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Customer Intents</Text>
                <Divider />
                {data.insights.topKeywords.length === 0 ? (
                  <Box paddingBlockStart="400" paddingBlockEnd="400">
                    <BlockStack inlineAlign="center" gap="200">
                      <div style={{ width: '28px', height: '28px', color: '#5c6ac4' }}>
                        <Icon source={ChatIcon} />
                      </div>
                      <Text as="p" tone="subdued" variant="bodySm" alignment="center">No conversation trends detected yet.</Text>
                    </BlockStack>
                  </Box>
                ) : (
                  <List type="number">
                    {data.insights.topKeywords.map(k => (
                      <List.Item key={k.word}>
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="span" fontWeight="medium" variant="bodyMd">{k.word}</Text>
                          <Text as="span" tone="subdued" variant="bodySm">{k.freq} mentions</Text>
                        </InlineStack>
                      </List.Item>
                    ))}
                  </List>
                )}
              </BlockStack>
            </Card>
          </div>

          <div style={{ flex: 1, minWidth: '30%' }}>
            <Card padding="500">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Most Clicked</Text>
                <Divider />
                {data.insights.topClicked.length === 0 ? (
                  <Box paddingBlockStart="400" paddingBlockEnd="400">
                    <BlockStack inlineAlign="center" gap="200">
                      <div style={{ width: '28px', height: '28px', color: '#5c6ac4' }}>
                        <Icon source={ProductIcon} />
                      </div>
                      <Text as="p" tone="subdued" variant="bodySm" alignment="center">No products clicked yet.</Text>
                    </BlockStack>
                  </Box>
                ) : (
                  <List type="bullet">
                    {data.insights.topClicked.map(p => (
                      <List.Item key={p.handle}>
                        <InlineStack align="space-between" blockAlign="center">
                          <div style={{ maxWidth: '60%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            <Text as="span" variant="bodyMd">{p.title}</Text>
                          </div>
                          <Text as="span" tone="subdued" variant="bodySm">{p.count} clicks</Text>
                        </InlineStack>
                      </List.Item>
                    ))}
                  </List>
                )}
              </BlockStack>
            </Card>
          </div>

          <div style={{ flex: 1, minWidth: '30%' }}>
            <Card padding="500">
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Top Conversions</Text>
                <Divider />
                {data.insights.topAtc.length === 0 ? (
                  <Box paddingBlockStart="400" paddingBlockEnd="400">
                    <BlockStack inlineAlign="center" gap="200">
                      <div style={{ width: '28px', height: '28px', color: '#5c6ac4' }}>
                        <Icon source={CartIcon} />
                      </div>
                      <Text as="p" tone="subdued" variant="bodySm" alignment="center">No cart additions yet.</Text>
                    </BlockStack>
                  </Box>
                ) : (
                  <List type="bullet">
                    {data.insights.topAtc.map(p => (
                      <List.Item key={p.title}>
                        <InlineStack align="space-between" blockAlign="center">
                          <div style={{ maxWidth: '60%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            <Text as="span" variant="bodyMd">{p.title}</Text>
                          </div>
                          <Text as="span" tone="subdued" variant="bodySm">{p.count} added</Text>
                        </InlineStack>
                      </List.Item>
                    ))}
                  </List>
                )}
              </BlockStack>
            </Card>
          </div>
        </InlineStack>

        {/* Minimalist Catalog Health */}
        <Card padding="500">
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text variant="headingMd" as="h2">Product Catalog Sync</Text>
                <Text variant="bodySm" tone="subdued" as="p">Keep your products up to date so the AI has the latest inventory knowledge.</Text>
              </BlockStack>
              <form action="/app/catalog" method="POST">
                <Button submit loading={isSyncing} variant="secondary">Sync manually</Button>
              </form>
            </InlineStack>

            <div style={{ height: '32px' }} /> {/* Spacing */}

            <InlineStack gap="600" blockAlign="end">
              <BlockStack gap="100">
                <Text as="h3" variant="bodySm" tone="subdued">Status</Text>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{
                    width: '8px', height: '8px', borderRadius: '50%',
                    backgroundColor: data.catalog.status === 'SUCCESS' ? '#10b981' : data.catalog.status === 'FAILED' ? '#ef4444' : '#eab308'
                  }} />
                  <Text as="span" variant="bodyMd" fontWeight="medium">
                    {data.catalog.status === "NEVER_SYNCED" ? "Awaiting initial sync" : data.catalog.status === "SUCCESS" ? 'Fully synced' : 'Failed'}
                  </Text>
                </div>
              </BlockStack>

              <BlockStack gap="100">
                <Text as="h3" variant="bodySm" tone="subdued">Available products</Text>
                <Text as="p" variant="bodyMd" fontWeight="medium">{String(data.catalog.productCount)}</Text>
              </BlockStack>

              <BlockStack gap="100">
                <Text as="h3" variant="bodySm" tone="subdued">Last operation</Text>
                <Text as="p" variant="bodyMd">
                  {data.catalog.lastSyncedAt ? new Date(data.catalog.lastSyncedAt).toLocaleString() : 'N/A'}
                </Text>
              </BlockStack>

              {data.catalog.lastSyncError && (
                <BlockStack gap="100">
                  <Text as="h3" variant="bodySm" tone="subdued">Diagnostic</Text>
                  <Text as="p" variant="bodyMd" tone="critical">{data.catalog.lastSyncError}</Text>
                </BlockStack>
              )}
            </InlineStack>
          </BlockStack>
        </Card>

      </BlockStack>
    </Page>
  );
}
