import { useState, useCallback, useEffect } from "react";
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
    Select,
    TextField,
    Tag,
    Banner,
    Divider,
    Badge,
    Box,
    RangeSlider,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── Types ───────────────────────────────────────────────────────────────────
type EligibilityMode = "ALL_PRODUCTS" | "BY_TAG" | "BY_COLLECTION";
type WidgetPosition = "bottom-right" | "bottom-left";

interface SettingsData {
    shopDomain: string;
    isActive: boolean;
    eligibilityMode: EligibilityMode;
    eligibilityTags: string[];
    eligibilityCollectionIds: string[];
    greetingText: string;
    widgetPosition: WidgetPosition;
    primaryColor: string;
    borderRadius: number;
    avatarUrl: string | null;
}


interface ValidationErrors {
    greetingText?: string;
    eligibilityTags?: string;
    eligibilityCollectionIds?: string;
    primaryColor?: string;
    avatarUrl?: string;
}

// ── Loader ──────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { session } = await authenticate.admin(request);
    const shopDomain = session.shop;

    let shop = await db.shop.findUnique({
        where: { domain: shopDomain },
        include: { merchantSettings: true },
    });

    if (!shop) {
        shop = await db.shop.create({
            data: {
                domain: shopDomain,
                merchantSettings: { create: {} },
            },
            include: { merchantSettings: true },
        });
    } else if (shop.status === "UNINSTALLED") {
        // Reinstall: reactivate the shop record
        shop = await db.shop.update({
            where: { id: shop.id },
            data: {
                status: "ACTIVE",
                uninstalledAt: null,
            },
            include: { merchantSettings: true },
        });
        console.log(`[Reinstall] Shop ${shopDomain} reactivated from UNINSTALLED to ACTIVE`);
    }

    if (!shop.merchantSettings) {
        const settings = await db.merchantSettings.create({
            data: { shopId: shop.id },
        });
        shop = { ...shop, merchantSettings: settings };
    }

    const s = shop.merchantSettings!;

    return json<SettingsData>({
        shopDomain,
        isActive: s.isActive,
        eligibilityMode: (s.eligibilityMode || "ALL_PRODUCTS") as EligibilityMode,
        eligibilityTags: s.eligibilityTags || [],
        eligibilityCollectionIds: s.eligibilityCollectionIds || [],
        greetingText: s.greetingText || "Find the perfect product for your pet!",
        widgetPosition: (s.widgetPosition || "bottom-right") as WidgetPosition,
        primaryColor: s.primaryColor,
        borderRadius: s.borderRadius,
        avatarUrl: s.avatarUrl,
    });
};

// ── Action ──────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
    const { session, admin } = await authenticate.admin(request);
    const shopDomain = session.shop;
    const formData = await request.formData();

    const intent = formData.get("intent") as string;

    const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop) {
        return json({ success: false, errors: { general: "Shop not found" } }, { status: 404 });
    }

    // Handle toggle separately for instant feedback
    if (intent === "toggle") {
        const newValue = formData.get("isActive") === "true";
        await db.merchantSettings.upsert({
            where: { shopId: shop.id },
            update: { isActive: newValue },
            create: { shopId: shop.id, isActive: newValue },
        });

        // ── Manage ScriptTag ──────────────────────────────────────────────────
        const baseUrl = new URL(request.url).origin.replace(/^http:/, 'https:');
        const scriptUrl = `${baseUrl}/api/widget.js`;

        const response: any = await admin.graphql(`
          #graphql
          query {
            scriptTags(first: 50) {
              edges {
                node {
                  id
                  src
                }
              }
            }
          }
        `);
        const data: any = await response.json();
        const scriptTags = data.data?.scriptTags?.edges || [];

        // Always delete ALL existing widget.js scripts (cleans up stale tunnel URLs)
        for (const edge of scriptTags) {
            if (edge.node.src.includes('/api/widget.js') || edge.node.src.includes('/api/widget')) {
                await admin.graphql(`
                  #graphql
                  mutation scriptTagDelete($id: ID!) {
                    scriptTagDelete(id: $id) {
                      deletedScriptTagId
                    }
                  }
                `, { variables: { id: edge.node.id } });
                console.log(`[ScriptTag] Deleted stale: ${edge.node.src}`);
            }
        }

        // Clear stored scriptTagId after cleanup
        await db.shop.update({
            where: { domain: shopDomain },
            data: { scriptTagId: null },
        });

        // If activating, inject fresh ScriptTag with current tunnel URL
        if (newValue) {
            const createResponse: any = await admin.graphql(`
              #graphql
              mutation scriptTagCreate($input: ScriptTagInput!) {
                scriptTagCreate(input: $input) {
                  scriptTag {
                    id
                  }
                }
              }
            `, {
                variables: {
                    input: {
                        src: scriptUrl,
                        displayScope: "ALL"
                    }
                }
            });
            const createData: any = await createResponse.json();
            const newScriptTagId = createData.data?.scriptTagCreate?.scriptTag?.id;

            // Persist the ScriptTag GID so uninstall cleanup knows what was active
            if (newScriptTagId) {
                await db.shop.update({
                    where: { domain: shopDomain },
                    data: { scriptTagId: newScriptTagId },
                });
            }
            console.log(`[ScriptTag] Injected fresh: ${scriptUrl} (id: ${newScriptTagId})`);
        }

        return json({ success: true, intent: "toggle" });
    }

    // Handle full save
    const eligibilityMode = formData.get("eligibilityMode") as string;
    const eligibilityTagsRaw = formData.get("eligibilityTags") as string;
    const eligibilityCollectionIdsRaw = formData.get("eligibilityCollectionIds") as string;
    const greetingText = (formData.get("greetingText") as string || "").trim();
    const widgetPosition = formData.get("widgetPosition") as string;
    const primaryColor = formData.get("primaryColor") as string;
    const borderRadius = parseInt(formData.get("borderRadius") as string, 10) || 16;
    const avatarUrlRaw = (formData.get("avatarUrl") as string || "").trim();
    const avatarUrl = avatarUrlRaw === "" ? null : avatarUrlRaw;

    // Parse arrays
    const eligibilityTags = eligibilityTagsRaw
        ? eligibilityTagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
        : [];
    const eligibilityCollectionIds = eligibilityCollectionIdsRaw
        ? eligibilityCollectionIdsRaw.split(",").map((c) => c.trim()).filter(Boolean)
        : [];

    // Validation
    const errors: Record<string, string> = {};

    if (!greetingText) {
        errors.greetingText = "Greeting text is required.";
    } else if (greetingText.length > 200) {
        errors.greetingText = "Greeting text must be 200 characters or less.";
    }

    if (eligibilityMode === "BY_TAG" && eligibilityTags.length === 0) {
        errors.eligibilityTags = "At least one tag is required when using tag-based filtering.";
    }

    if (eligibilityMode === "BY_COLLECTION" && eligibilityCollectionIds.length === 0) {
        errors.eligibilityCollectionIds =
            "At least one collection ID is required when using collection-based filtering.";
    }

    if (!["ALL_PRODUCTS", "BY_TAG", "BY_COLLECTION"].includes(eligibilityMode)) {
        errors.eligibilityMode = "Invalid eligibility mode.";
    }

    if (!["bottom-right", "bottom-left"].includes(widgetPosition)) {
        errors.widgetPosition = "Invalid widget position.";
    }

    if (!/^#[0-9A-F]{6}$/i.test(primaryColor)) {
        errors.primaryColor = "Primary color must be a valid hex code (e.g. #22c55e).";
    }

    if (avatarUrl && !/^https?:\/\/.+/.test(avatarUrl)) {
        errors.avatarUrl = "Avatar URL must be a valid http or https link.";
    }

    if (Object.keys(errors).length > 0) {
        return json({ success: false, errors, intent: "save" }, { status: 422 });
    }

    await db.merchantSettings.upsert({
        where: { shopId: shop.id },
        update: {
            eligibilityMode,
            eligibilityTags,
            eligibilityCollectionIds,
            greetingText,
            widgetPosition,
            primaryColor,
            borderRadius,
            avatarUrl,
        },
        create: {
            shopId: shop.id,
            eligibilityMode,
            eligibilityTags,
            eligibilityCollectionIds,
            greetingText,
            widgetPosition,
            primaryColor,
            borderRadius,
            avatarUrl,
        },
    });

    console.log(`[Settings] Saved for ${shopDomain}: mode=${eligibilityMode}, color=${primaryColor}`);

    return json({ success: true, intent: "save" });
};

// ── Component ───────────────────────────────────────────────────────────────
export default function Settings() {
    const loaderData = useLoaderData<typeof loader>() as SettingsData;
    const fetcher = useFetcher<any>();
    const shopify = useAppBridge();

    // Local form state
    const [isActive, setIsActive] = useState(loaderData.isActive);
    const [eligibilityMode, setEligibilityMode] = useState<EligibilityMode>(loaderData.eligibilityMode);
    const [tagInput, setTagInput] = useState("");
    const [tags, setTags] = useState<string[]>(loaderData.eligibilityTags || []);
    const [collectionInput, setCollectionInput] = useState((loaderData.eligibilityCollectionIds || []).join(", "));
    const [greetingText, setGreetingText] = useState(loaderData.greetingText);
    const [widgetPosition, setWidgetPosition] = useState<WidgetPosition>(loaderData.widgetPosition);
    const [primaryColor, setPrimaryColor] = useState(loaderData.primaryColor);
    const [borderRadius, setBorderRadius] = useState(loaderData.borderRadius);
    const [avatarUrl, setAvatarUrl] = useState(loaderData.avatarUrl || "");
    const [errors, setErrors] = useState<ValidationErrors>({});

    const isSaving = fetcher.state !== "idle";

    // Show toast on successful save
    useEffect(() => {
        if (fetcher.data?.success && fetcher.data?.intent === "save") {
            shopify.toast.show("Settings saved");
            setErrors({});
        }
        if (fetcher.data?.success && fetcher.data?.intent === "toggle") {
            shopify.toast.show(isActive ? "PetMatch activated" : "PetMatch deactivated");
        }
        if (fetcher.data?.errors && fetcher.data?.intent === "save") {
            setErrors(fetcher.data.errors);
        }
    }, [fetcher.data]);

    // ── Toggle handler ──────────────────────────────────────────────────────
    const handleToggle = useCallback(() => {
        const newValue = !isActive;
        setIsActive(newValue);
        fetcher.submit(
            { intent: "toggle", isActive: String(newValue) },
            { method: "POST" },
        );
    }, [isActive, fetcher]);

    // ── Tag helpers ─────────────────────────────────────────────────────────
    const addTag = useCallback(() => {
        const trimmed = tagInput.trim();
        if (trimmed && !tags.includes(trimmed)) {
            setTags([...tags, trimmed]);
            setTagInput("");
            setErrors((prev) => ({ ...prev, eligibilityTags: undefined }));
        }
    }, [tagInput, tags]);

    const removeTag = useCallback(
        (tagToRemove: string) => {
            setTags(tags.filter((t) => t !== tagToRemove));
        },
        [tags],
    );

    const handleTagKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag();
            }
        },
        [addTag],
    );

    // ── Save handler ────────────────────────────────────────────────────────
    const handleSave = useCallback(() => {
        // Client-side validation
        const newErrors: ValidationErrors = {};

        if (!greetingText.trim()) {
            newErrors.greetingText = "Greeting text is required.";
        } else if (greetingText.length > 200) {
            newErrors.greetingText = "Greeting text must be 200 characters or less.";
        }

        if (eligibilityMode === "BY_TAG" && tags.length === 0) {
            newErrors.eligibilityTags = "At least one tag is required.";
        }

        const parsedCollections = collectionInput
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean);

        if (eligibilityMode === "BY_COLLECTION" && parsedCollections.length === 0) {
            newErrors.eligibilityCollectionIds = "At least one collection ID is required.";
        }

        if (Object.keys(newErrors).length > 0) {
            setErrors(newErrors);
            return;
        }

        setErrors({});
        fetcher.submit(
            {
                intent: "save",
                eligibilityMode,
                eligibilityTags: tags.join(","),
                eligibilityCollectionIds: collectionInput,
                greetingText: greetingText.trim(),
                widgetPosition,
                primaryColor,
                borderRadius: String(borderRadius),
                avatarUrl: avatarUrl.trim(),
            },
            { method: "POST" },
        );
    }, [eligibilityMode, tags, collectionInput, greetingText, widgetPosition, primaryColor, borderRadius, avatarUrl, fetcher]);

    // ── Eligibility mode options ────────────────────────────────────────────
    const eligibilityOptions = [
        { label: "All Products", value: "ALL_PRODUCTS" },
        { label: "By Tag", value: "BY_TAG" },
        { label: "By Collection", value: "BY_COLLECTION" },
    ];

    const positionOptions = [
        { label: "Bottom Right", value: "bottom-right" },
        { label: "Bottom Left", value: "bottom-left" },
    ];

    // ── Render ──────────────────────────────────────────────────────────────
    return (
        <Page>
            <TitleBar title="Settings" />
            <BlockStack gap="500">
                {/* ── Card 1: Enable/Disable ─────────────────────────────── */}
                <Layout>
                    <Layout.AnnotatedSection
                        id="enable"
                        title="Enable PetMatch"
                        description="Activate or deactivate the AI pet matching feature on your storefront."
                    >
                        <Card>
                            <InlineStack align="space-between" blockAlign="center">
                                <InlineStack gap="300" blockAlign="center">
                                    <Text as="p" variant="bodyMd">
                                        PetMatch is currently
                                    </Text>
                                    <Badge tone={isActive ? "success" : undefined}>
                                        {isActive ? "Active" : "Inactive"}
                                    </Badge>
                                </InlineStack>
                                <Button
                                    onClick={handleToggle}
                                    loading={isSaving && fetcher.formData?.get("intent") === "toggle"}
                                    tone={isActive ? "critical" : undefined}
                                    variant={isActive ? "secondary" : "primary"}
                                >
                                    {isActive ? "Deactivate" : "Activate"}
                                </Button>
                            </InlineStack>
                        </Card>
                    </Layout.AnnotatedSection>
                </Layout>

                {/* ── Card 2: Product Eligibility ─────────────────────────── */}
                <Layout>
                    <Layout.AnnotatedSection
                        id="eligibility"
                        title="Product Eligibility"
                        description="Choose which products PetMatch can recommend to customers."
                    >
                        <Card>
                            <BlockStack gap="400">
                                <Select
                                    label="Eligibility mode"
                                    options={eligibilityOptions}
                                    value={eligibilityMode}
                                    onChange={(val) => {
                                        setEligibilityMode(val as EligibilityMode);
                                        setErrors((prev) => ({
                                            ...prev,
                                            eligibilityTags: undefined,
                                            eligibilityCollectionIds: undefined,
                                        }));
                                    }}
                                />

                                {eligibilityMode === "BY_TAG" && (
                                    <BlockStack gap="300">
                                        <TextField
                                            label="Add tags"
                                            value={tagInput}
                                            onChange={setTagInput}
                                            placeholder="Type a tag and click Add"
                                            helpText="Enter product tags to filter eligible products."
                                            autoComplete="off"
                                            error={errors.eligibilityTags}
                                            connectedRight={
                                                <Button onClick={addTag} disabled={!tagInput.trim()}>
                                                    Add
                                                </Button>
                                            }
                                        />
                                        {tags.length > 0 && (
                                            <InlineStack gap="200">
                                                {tags.map((tag) => (
                                                    <Tag key={tag} onRemove={() => removeTag(tag)}>
                                                        {tag}
                                                    </Tag>
                                                ))}
                                            </InlineStack>
                                        )}
                                    </BlockStack>
                                )}

                                {eligibilityMode === "BY_COLLECTION" && (
                                    <TextField
                                        label="Collection IDs"
                                        value={collectionInput}
                                        onChange={(val) => {
                                            setCollectionInput(val);
                                            setErrors((prev) => ({
                                                ...prev,
                                                eligibilityCollectionIds: undefined,
                                            }));
                                        }}
                                        placeholder="e.g. 123456789, 987654321"
                                        helpText="Enter Shopify collection IDs separated by commas."
                                        autoComplete="off"
                                        error={errors.eligibilityCollectionIds}
                                    />
                                )}

                                {eligibilityMode === "ALL_PRODUCTS" && (
                                    <Banner tone="info">
                                        <p>All products in your store will be eligible for PetMatch recommendations.</p>
                                    </Banner>
                                )}
                            </BlockStack>
                        </Card>
                    </Layout.AnnotatedSection>
                </Layout>

                {/* ── Card 3: Widget Configuration ────────────────────────── */}
                <Layout>
                    <Layout.AnnotatedSection
                        id="widget"
                        title="Widget Configuration"
                        description="Customize the look and feel of the PetMatch widget on your storefront."
                    >
                        <BlockStack gap="400">
                            <Card>
                                <BlockStack gap="400">
                                    <TextField
                                        label="Primary Color Theme (Hex)"
                                        value={primaryColor}
                                        onChange={(val) => {
                                            setPrimaryColor(val);
                                            setErrors((prev) => ({ ...prev, primaryColor: undefined }));
                                        }}
                                        placeholder="#22c55e"
                                        autoComplete="off"
                                        error={errors.primaryColor}
                                        helpText="The main color of the widget button and bubbles."
                                    />
                                    <RangeSlider
                                        label="Border Radius"
                                        value={borderRadius}
                                        onChange={(val) => setBorderRadius(Number(val))}
                                        output
                                        min={0}
                                        max={24}
                                        helpText="How rounded the widget corners should be (0 to 24px)."
                                    />
                                    <Select
                                        label="Widget position"
                                        options={positionOptions}
                                        value={widgetPosition}
                                        onChange={(val) => setWidgetPosition(val as WidgetPosition)}
                                        helpText="Where the PetMatch widget appears on your storefront."
                                    />
                                    <TextField
                                        label="Greeting text"
                                        value={greetingText}
                                        onChange={(val) => {
                                            setGreetingText(val);
                                            setErrors((prev) => ({ ...prev, greetingText: undefined }));
                                        }}
                                        placeholder="Find the perfect product for your pet!"
                                        helpText={`${greetingText.length}/200 characters`}
                                        maxLength={200}
                                        autoComplete="off"
                                        error={errors.greetingText}
                                        showCharacterCount
                                    />
                                    <TextField
                                        label="Bot Avatar URL (Optional)"
                                        value={avatarUrl}
                                        onChange={(val) => {
                                            setAvatarUrl(val);
                                            setErrors((prev) => ({ ...prev, avatarUrl: undefined }));
                                        }}
                                        placeholder="https://example.com/bot-icon.png"
                                        autoComplete="off"
                                        error={errors.avatarUrl}
                                        helpText="A direct link to an image for the bot's avatar. Leave blank for default."
                                    />
                                </BlockStack>
                            </Card>

                            {/* Live Preview Card */}
                            <Card>
                                <BlockStack gap="300">
                                    <Text as="h3" variant="headingMd">Live Preview</Text>
                                    <Box
                                        padding="400"
                                        background="bg-surface-secondary"
                                        borderRadius="200"
                                    >
                                        <div style={{
                                            border: '1px solid #e1e3e5',
                                            borderRadius: `${borderRadius}px`,
                                            padding: '16px',
                                            backgroundColor: '#ffffff',
                                            maxWidth: '300px',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: '12px'
                                        }}>
                                            <div style={{
                                                backgroundColor: primaryColor || '#22c55e',
                                                color: '#fff',
                                                padding: '12px',
                                                borderRadius: `${borderRadius}px ${borderRadius}px 0 0`,
                                                fontWeight: 'bold',
                                                textAlign: 'center'
                                            }}>
                                                PetMatch AI
                                            </div>
                                            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                                                {avatarUrl ? (
                                                    <img src={avatarUrl} alt="Bot Avatar" style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }} />
                                                ) : (
                                                    <div style={{ width: '32px', height: '32px', borderRadius: '50%', backgroundColor: '#e1e3e5' }} />
                                                )}
                                                <div style={{
                                                    backgroundColor: '#f4f6f8',
                                                    padding: '8px 12px',
                                                    borderRadius: `0 ${borderRadius}px ${borderRadius}px ${borderRadius}px`,
                                                    fontSize: '14px',
                                                    color: '#202223'
                                                }}>
                                                    {greetingText || "Hi! Tell me about your pet."}
                                                </div>
                                            </div>
                                        </div>
                                    </Box>
                                </BlockStack>
                            </Card>
                        </BlockStack>
                    </Layout.AnnotatedSection>
                </Layout>

                {/* ── Save Bar ────────────────────────────────────────────── */}
                <Layout>
                    <Layout.Section>
                        <InlineStack align="end">
                            <Button
                                variant="primary"
                                onClick={handleSave}
                                loading={isSaving && fetcher.formData?.get("intent") === "save"}
                                size="large"
                            >
                                Save settings
                            </Button>
                        </InlineStack>
                    </Layout.Section>
                </Layout>

                <Box paddingBlockEnd="800" />
            </BlockStack>
        </Page>
    );
}
