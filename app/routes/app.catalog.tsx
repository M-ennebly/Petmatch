import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
    Page,
    Layout,
    Card,
    Text,
    BlockStack,
    InlineStack,
    Button,
    Badge,
    Banner,
    DataTable,
    Thumbnail,
    SkeletonBodyText,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── GraphQL query ───────────────────────────────────────────────────────────
const PRODUCTS_QUERY = `#graphql
  query getProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      edges {
        node {
          id
          title
          handle
          productType
          vendor
          tags
          status
          featuredMedia {
            preview {
              image {
                url
              }
            }
          }
          priceRangeV2 {
            minVariantPrice { amount }
            maxVariantPrice { amount }
          }
          variants(first: 1) {
            edges {
              node {
                id
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// ── Loader ──────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { session } = await authenticate.admin(request);
    const shopDomain = session.shop;

    const [productCount, lastSync, recentProducts] = await Promise.all([
        db.product.count({ where: { shopDomain } }),
        db.syncLog.findFirst({
            where: { shopDomain },
            orderBy: { startedAt: "desc" },
        }),
        db.product.findMany({
            where: { shopDomain },
            orderBy: { updatedAt: "desc" },
            take: 20,
            select: {
                id: true,
                title: true,
                handle: true,
                productType: true,
                vendor: true,
                tags: true,
                featuredImage: true,
                minPrice: true,
                maxPrice: true,
                status: true,
            },
        }),
    ]);

    return json({
        shopDomain,
        productCount,
        lastSync: lastSync
            ? {
                status: lastSync.status,
                productCount: lastSync.productCount,
                startedAt: lastSync.startedAt.toISOString(),
                completedAt: lastSync.completedAt?.toISOString() ?? null,
                error: lastSync.error,
            }
            : null,
        recentProducts,
    });
};

// ── Action: sync products ───────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
    const { session, admin } = await authenticate.admin(request);
    const shopDomain = session.shop;

    // Check if force sync
    const formData = await request.formData();
    const isForce = formData.get("force") === "true";

    // Create a sync log entry
    const syncLog = await db.syncLog.create({
        data: { shopDomain, status: "RUNNING" },
    });

    try {
        let cursor: string | null = null;
        let hasNextPage = true;
        let totalSynced = 0;

        // If force sync, delete all existing products for this shop first
        if (isForce) {
            await db.product.deleteMany({ where: { shopDomain } });
            console.log(`[Catalog Sync] ${shopDomain}: Truncated products for force sync`);
        }

        while (hasNextPage) {
            const response: any = await admin.graphql(PRODUCTS_QUERY, {
                variables: {
                    after: cursor,
                },
            });
            const data: any = await response.json();
            const products: any = data.data!.products;

            // Upsert each product
            for (const edge of products.edges) {
                const node = edge.node;
                const imageUrl =
                    node.featuredMedia?.preview?.image?.url ?? null;
                const minPrice =
                    node.priceRangeV2?.minVariantPrice?.amount ?? "0.00";
                const maxPrice =
                    node.priceRangeV2?.maxVariantPrice?.amount ?? "0.00";
                const firstVariantFullId = node.variants?.edges?.[0]?.node?.id ?? null;
                const firstVariantId = firstVariantFullId
                    ? firstVariantFullId.replace("gid://shopify/ProductVariant/", "")
                    : null;

                await db.product.upsert({
                    where: {
                        shopDomain_shopifyId: {
                            shopDomain,
                            shopifyId: node.id,
                        },
                    },
                    update: {
                        title: node.title,
                        handle: node.handle,
                        productType: node.productType || "",
                        vendor: node.vendor || "",
                        tags: node.tags || [],
                        featuredImage: imageUrl,
                        minPrice,
                        maxPrice,
                        firstVariantId,
                        status: node.status,
                    },
                    create: {
                        shopDomain,
                        shopifyId: node.id,
                        title: node.title,
                        handle: node.handle,
                        productType: node.productType || "",
                        vendor: node.vendor || "",
                        tags: node.tags || [],
                        featuredImage: imageUrl,
                        minPrice,
                        maxPrice,
                        firstVariantId,
                        status: node.status,
                    },
                });

                totalSynced++;
            }

            hasNextPage = products.pageInfo.hasNextPage;
            cursor = products.pageInfo.endCursor;
        }

        // Update sync log
        await db.syncLog.update({
            where: { id: syncLog.id },
            data: {
                status: "COMPLETED",
                productCount: totalSynced,
                completedAt: new Date(),
            },
        });

        console.log(
            `[Catalog Sync] ${shopDomain}: synced ${totalSynced} products`,
        );

        return json({ success: true, productCount: totalSynced });
    } catch (error: any) {
        await db.syncLog.update({
            where: { id: syncLog.id },
            data: {
                status: "FAILED",
                error: error.message || "Unknown error",
                completedAt: new Date(),
            },
        });

        console.error(`[Catalog Sync] ${shopDomain}: FAILED`, error);
        return json(
            { success: false, error: error.message || "Sync failed" },
            { status: 500 },
        );
    }
};

// ── Component ───────────────────────────────────────────────────────────────
export default function Catalog() {
    const { productCount, lastSync, recentProducts } =
        useLoaderData<typeof loader>();
    const fetcher = useFetcher<typeof action>();
    const shopify = useAppBridge();

    const isSyncing = fetcher.state !== "idle";

    // After sync completes, show toast
    if (fetcher.data && !isSyncing) {
        if ((fetcher.data as any).success) {
            shopify.toast.show(
                `Synced ${(fetcher.data as any).productCount} products`,
            );
        } else if ((fetcher.data as any).error) {
            shopify.toast.show((fetcher.data as any).error, { isError: true });
        }
    }

    const handleSync = () => {
        fetcher.submit({}, { method: "POST" });
    };

    const handleForceSync = () => {
        fetcher.submit({ force: "true" }, { method: "POST" });
    };

    // Format date
    const formatDate = (iso: string | null) => {
        if (!iso) return "—";
        return new Date(iso).toLocaleString();
    };

    // Status badge tone
    const syncStatusTone = (status: string | undefined) => {
        if (!status) return undefined;
        if (status === "COMPLETED") return "success" as const;
        if (status === "FAILED") return "critical" as const;
        return "attention" as const;
    };

    // Build table rows from recent products
    const tableRows = recentProducts.map((p: any) => [
        p.featuredImage ? (
            <Thumbnail source={p.featuredImage} alt={p.title} size="small" />
        ) : (
            <Thumbnail source="" alt="No image" size="small" />
        ),
        p.title,
        p.productType || "—",
        p.vendor || "—",
        (p.tags || []).length > 0 ? (p.tags as string[]).join(", ") : "—",
        `$${p.minPrice} – $${p.maxPrice}`,
    ]);

    return (
        <Page>
            <TitleBar title="Product Catalog" />
            <BlockStack gap="500">
                {/* ── Sync Status Card ──────────────────────────────────── */}
                <Layout>
                    <Layout.Section>
                        <Card>
                            <BlockStack gap="400">
                                <InlineStack align="space-between" blockAlign="center">
                                    <BlockStack gap="200">
                                        <Text as="h2" variant="headingMd">
                                            Product Sync
                                        </Text>
                                        <InlineStack gap="300" blockAlign="center">
                                            <Text as="p" variant="bodyMd">
                                                <strong>{productCount}</strong> products stored
                                            </Text>
                                            {lastSync && (
                                                <Badge tone={syncStatusTone(lastSync.status)}>
                                                    {lastSync.status}
                                                </Badge>
                                            )}
                                        </InlineStack>
                                        {lastSync && (
                                            <Text as="p" variant="bodySm" tone="subdued">
                                                Last sync: {formatDate(lastSync.completedAt || lastSync.startedAt)}
                                                {lastSync.productCount > 0 &&
                                                    ` • ${lastSync.productCount} products`}
                                            </Text>
                                        )}
                                    </BlockStack>
                                    <InlineStack gap="200">
                                        <Button
                                            onClick={handleForceSync}
                                            loading={isSyncing}
                                            size="large"
                                            tone="critical"
                                        >
                                            Force resync
                                        </Button>
                                        <Button
                                            variant="primary"
                                            onClick={handleSync}
                                            loading={isSyncing}
                                            size="large"
                                        >
                                            {isSyncing ? "Syncing..." : "Sync products"}
                                        </Button>
                                    </InlineStack>
                                </InlineStack>

                                {lastSync?.error && (
                                    <Banner tone="critical">
                                        <p>{lastSync.error}</p>
                                    </Banner>
                                )}

                                {isSyncing && (
                                    <Banner tone="info">
                                        <p>
                                            Fetching products from Shopify… This may take a moment for
                                            large catalogs.
                                        </p>
                                    </Banner>
                                )}
                            </BlockStack>
                        </Card>
                    </Layout.Section>
                </Layout>

                {/* ── Recent Products Table ─────────────────────────────── */}
                {recentProducts.length > 0 && (
                    <Layout>
                        <Layout.Section>
                            <Card>
                                <BlockStack gap="300">
                                    <Text as="h2" variant="headingMd">
                                        Recent Products (showing up to 20)
                                    </Text>
                                    <DataTable
                                        columnContentTypes={[
                                            "text",
                                            "text",
                                            "text",
                                            "text",
                                            "text",
                                            "text",
                                        ]}
                                        headings={[
                                            "Image",
                                            "Title",
                                            "Type",
                                            "Vendor",
                                            "Tags",
                                            "Price Range",
                                        ]}
                                        rows={tableRows}
                                    />
                                </BlockStack>
                            </Card>
                        </Layout.Section>
                    </Layout>
                )}

                {productCount === 0 && !isSyncing && (
                    <Layout>
                        <Layout.Section>
                            <Banner tone="info">
                                <p>
                                    No products synced yet. Click "Sync products" above to fetch
                                    your product catalog from Shopify.
                                </p>
                            </Banner>
                        </Layout.Section>
                    </Layout>
                )}
            </BlockStack>
        </Page>
    );
}
