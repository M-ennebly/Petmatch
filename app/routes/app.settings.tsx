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
  storeKnowledge: string;
  customInstructions: string;
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
    console.log(
      `[Reinstall] Shop ${shopDomain} reactivated from UNINSTALLED to ACTIVE`,
    );
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
    storeKnowledge: s.storeKnowledge || "",
    customInstructions: s.customInstructions || "",
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
    return json(
      { success: false, errors: { general: "Shop not found" } },
      { status: 404 },
    );
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
    const baseUrl = new URL(request.url).origin.replace(/^http:/, "https:");
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
      if (
        edge.node.src.includes("/api/widget.js") ||
        edge.node.src.includes("/api/widget")
      ) {
        await admin.graphql(
          `
                  #graphql
                  mutation scriptTagDelete($id: ID!) {
                    scriptTagDelete(id: $id) {
                      deletedScriptTagId
                    }
                  }
                `,
          { variables: { id: edge.node.id } },
        );
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
      const createResponse: any = await admin.graphql(
        `
              #graphql
              mutation scriptTagCreate($input: ScriptTagInput!) {
                scriptTagCreate(input: $input) {
                  scriptTag {
                    id
                  }
                }
              }
            `,
        {
          variables: {
            input: {
              src: scriptUrl,
              displayScope: "ALL",
            },
          },
        },
      );
      const createData: any = await createResponse.json();
      const newScriptTagId = createData.data?.scriptTagCreate?.scriptTag?.id;

      // Persist the ScriptTag GID so uninstall cleanup knows what was active
      if (newScriptTagId) {
        await db.shop.update({
          where: { domain: shopDomain },
          data: { scriptTagId: newScriptTagId },
        });
      }
      console.log(
        `[ScriptTag] Injected fresh: ${scriptUrl} (id: ${newScriptTagId})`,
      );
    }

    return json({ success: true, intent: "toggle" });
  }

  // Handle full save
  const eligibilityMode = formData.get("eligibilityMode") as string;
  const eligibilityTagsRaw = formData.get("eligibilityTags") as string;
  const eligibilityCollectionIdsRaw = formData.get(
    "eligibilityCollectionIds",
  ) as string;
  const greetingText = ((formData.get("greetingText") as string) || "").trim();
  const widgetPosition = formData.get("widgetPosition") as string;
  const primaryColor = formData.get("primaryColor") as string;
  const borderRadius =
    parseInt(formData.get("borderRadius") as string, 10) || 16;
  const avatarUrlRaw = ((formData.get("avatarUrl") as string) || "").trim();
  const avatarUrl = avatarUrlRaw === "" ? null : avatarUrlRaw;
  const storeKnowledge =
    ((formData.get("storeKnowledge") as string) || "").trim() || null;
  const customInstructions =
    ((formData.get("customInstructions") as string) || "").trim() || null;

  // Parse arrays
  const eligibilityTags = eligibilityTagsRaw
    ? eligibilityTagsRaw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const eligibilityCollectionIds = eligibilityCollectionIdsRaw
    ? eligibilityCollectionIdsRaw
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
    : [];

  // Validation
  const errors: Record<string, string> = {};

  if (!greetingText) {
    errors.greetingText = "Greeting text is required.";
  } else if (greetingText.length > 200) {
    errors.greetingText = "Greeting text must be 200 characters or less.";
  }

  if (eligibilityMode === "BY_TAG" && eligibilityTags.length === 0) {
    errors.eligibilityTags =
      "At least one tag is required when using tag-based filtering.";
  }

  if (
    eligibilityMode === "BY_COLLECTION" &&
    eligibilityCollectionIds.length === 0
  ) {
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
    errors.primaryColor =
      "Primary color must be a valid hex code (e.g. #22c55e).";
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
      storeKnowledge,
      customInstructions,
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
      storeKnowledge,
      customInstructions,
    },
  });

  console.log(
    `[Settings] Saved for ${shopDomain}: mode=${eligibilityMode}, color=${primaryColor}`,
  );

  return json({ success: true, intent: "save" });
};

// ── Component ───────────────────────────────────────────────────────────────
export default function Settings() {
  const loaderData = useLoaderData<typeof loader>() as SettingsData;
  const fetcher = useFetcher<any>();
  const shopify = useAppBridge();

  // Local form state
  const [isActive, setIsActive] = useState(loaderData.isActive);
  const [eligibilityMode, setEligibilityMode] = useState<EligibilityMode>(
    loaderData.eligibilityMode,
  );
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>(loaderData.eligibilityTags || []);
  const [collectionInput, setCollectionInput] = useState(
    (loaderData.eligibilityCollectionIds || []).join(", "),
  );
  const [greetingText, setGreetingText] = useState(loaderData.greetingText);
  const [widgetPosition, setWidgetPosition] = useState<WidgetPosition>(
    loaderData.widgetPosition,
  );
  const [primaryColor, setPrimaryColor] = useState(loaderData.primaryColor);
  const [borderRadius, setBorderRadius] = useState(loaderData.borderRadius);
  const [avatarUrl, setAvatarUrl] = useState(loaderData.avatarUrl || "");
  const [storeKnowledge, setStoreKnowledge] = useState(
    loaderData.storeKnowledge || "",
  );
  const [customInstructions, setCustomInstructions] = useState(
    loaderData.customInstructions || "",
  );
  const [errors, setErrors] = useState<ValidationErrors>({});

  const [showSuccess, setShowSuccess] = useState(false);

  const isSaving = fetcher.state !== "idle";

  // Show toast on successful save
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.intent === "save") {
      shopify.toast.show("Settings saved");
      setErrors({});
      // Trigger local success animation
      setShowSuccess(false);
      setTimeout(() => setShowSuccess(true), 50);
      setTimeout(() => setShowSuccess(false), 3000);
    }
    if (fetcher.data?.success && fetcher.data?.intent === "toggle") {
      shopify.toast.show(
        isActive ? "PetMatch activated" : "PetMatch deactivated",
      );
    }
    if (fetcher.data?.errors && fetcher.data?.intent === "save") {
      setErrors(fetcher.data.errors);
    }
  }, [fetcher.data, isActive, shopify]);

  useEffect(() => {
    const sendUpdate = () => {
      const iframe = document.getElementById(
        "widget-preview-iframe",
      ) as HTMLIFrameElement;
      if (!iframe?.contentWindow) return;
      iframe.contentWindow.postMessage(
        {
          type: "PM_PREVIEW_UPDATE",
          primaryColor: primaryColor || "#FE9D28",
          borderRadius: borderRadius,
          widgetPosition: widgetPosition,
        },
        "*",
      );
    };

    // Small delay to ensure widget script has initialized
    const timer = setTimeout(sendUpdate, 100);
    return () => clearTimeout(timer);
  }, [primaryColor, borderRadius, widgetPosition]);

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
      newErrors.eligibilityCollectionIds =
        "At least one collection ID is required.";
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
        storeKnowledge,
        customInstructions,
      },
      { method: "POST" },
    );
  }, [
    eligibilityMode,
    tags,
    collectionInput,
    greetingText,
    widgetPosition,
    primaryColor,
    borderRadius,
    avatarUrl,
    storeKnowledge,
    customInstructions,
    fetcher,
  ]);

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
    <Page fullWidth>
      <TitleBar title="Settings" />

      <style>{`
                @keyframes pm-blob {
                    0% { transform: scale(0.95); opacity: 0; }
                    10% { transform: scale(1.05); opacity: 1; }
                    100% { transform: scale(1); opacity: 1; }
                }
                .anim-success { animation: pm-blob 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
                .pm-visual-card {
                    border: 2px solid #e1e3e5;
                    border-radius: 12px;
                    padding: 16px;
                    cursor: pointer;
                    background: white;
                    transition: all 0.15s ease;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 8px;
                    flex: 1;
                }
                .pm-visual-card:hover { border-color: #aaaaaa; }
                .pm-visual-card.selected { border-color: ${primaryColor || "#FE9D28"}; background: ${primaryColor || "#FE9D28"}10; }
                .pm-visual-card-label { font-size: 13px; font-weight: 500; color: #202223; }
                .pm-color-swatch {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    cursor: pointer;
                    border: 3px solid transparent;
                    transition: all 0.15s;
                    flex-shrink: 0;
                }
                .pm-color-swatch.selected { border-color: #202223; transform: scale(1.15); }
                .pm-color-swatch:hover { transform: scale(1.1); }
                .pm-section-title {
                    font-size: 11px;
                    font-weight: 600;
                    color: #6d7175;
                    text-transform: uppercase;
                    letter-spacing: 0.6px;
                    margin-bottom: 12px;
                }
                .pm-divider { height: 1px; background: #f1f2f3; margin: 20px 0; }
                .pm-settings-scroll::-webkit-scrollbar { width: 4px; }
                .pm-settings-scroll::-webkit-scrollbar-thumb { background: #e1e3e5; border-radius: 4px; }
            `}</style>

      <div
        style={{
          display: "flex",
          height: "calc(100vh - 56px)",
          overflow: "hidden",
          gap: 0,
        }}
      >
        {/* ── LEFT: Live Preview ──────────────────────────────────────────── */}
        <div
          style={{
            flex: 1,
            background: "#f6f6f7",
            position: "relative",
            overflow: "hidden",
            borderRight: "1px solid #e1e3e5",
          }}
        >
          <div style={{ position: "absolute", top: 16, left: 16, zIndex: 10 }}>
            <div
              style={{
                background: "white",
                borderRadius: "8px",
                padding: "6px 12px",
                fontSize: "11px",
                color: "#6d7175",
                fontWeight: 500,
                border: "1px solid #e1e3e5",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#22c55e",
                  display: "inline-block",
                }}
              />
              Live Preview
            </div>
          </div>
          <iframe
            id="widget-preview-iframe"
            src="/preview"
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              display: "block",
            }}
            title="Widget Preview"
            onLoad={() => {
              const iframe = document.getElementById(
                "widget-preview-iframe",
              ) as HTMLIFrameElement;
              if (!iframe?.contentWindow) return;
              iframe.contentWindow.postMessage(
                {
                  type: "PM_PREVIEW_UPDATE",
                  primaryColor: primaryColor || "#FE9D28",
                  borderRadius: borderRadius,
                  widgetPosition: widgetPosition,
                },
                "*",
              );
            }}
          />
        </div>

        {/* ── RIGHT: Settings Panel ───────────────────────────────────────── */}
        <div
          className="pm-settings-scroll"
          style={{
            width: "420px",
            flexShrink: 0,
            overflowY: "auto",
            background: "white",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "24px 24px 0",
              borderBottom: "1px solid #f1f2f3",
              paddingBottom: "20px",
              position: "sticky",
              top: 0,
              background: "white",
              zIndex: 10,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: "20px",
                    fontWeight: "700",
                    color: "#202223",
                    letterSpacing: "-0.3px",
                  }}
                >
                  PetMatch
                </div>
                <div
                  style={{
                    fontSize: "13px",
                    color: "#6d7175",
                    marginTop: "2px",
                  }}
                >
                  Your AI pet shopping assistant
                </div>
              </div>
              <div
                style={{ display: "flex", alignItems: "center", gap: "10px" }}
              >
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: 500,
                    color: isActive ? "#108043" : "#6d7175",
                    background: isActive ? "#f1f8f5" : "#f6f6f7",
                    padding: "4px 10px",
                    borderRadius: "20px",
                    border: `1px solid ${isActive ? "#c3e6d4" : "#e1e3e5"}`,
                  }}
                >
                  {isActive ? "● Active" : "○ Inactive"}
                </div>
                <button
                  type="button"
                  onClick={handleToggle}
                  disabled={
                    isSaving && fetcher.formData?.get("intent") === "toggle"
                  }
                  style={{
                    padding: "8px 14px",
                    borderRadius: "8px",
                    border: "none",
                    background: isActive ? "#fff0f0" : "#202223",
                    color: isActive ? "#d72c0d" : "white",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  {isActive ? "Deactivate" : "Activate"}
                </button>
              </div>
            </div>
          </div>

          {/* Settings Content */}
          <div
            style={{
              padding: "24px",
              display: "flex",
              flexDirection: "column",
              gap: "24px",
              flex: 1,
            }}
          >
            {/* ── Accent Color ──────────────────────────────── */}
            <div>
              <div className="pm-section-title">Accent Color</div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  flexWrap: "wrap",
                }}
              >
                {[
                  "#FE9D28",
                  "#6366f1",
                  "#ec4899",
                  "#ef4444",
                  "#22c55e",
                  "#0ea5e9",
                  "#8b5cf6",
                  "#f59e0b",
                ].map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`pm-color-swatch ${primaryColor === color ? "selected" : ""}`}
                    style={{ background: color }}
                    onClick={() => setPrimaryColor(color)}
                    title={color}
                  />
                ))}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginLeft: "4px",
                  }}
                >
                  <input
                    type="color"
                    value={primaryColor || "#FE9D28"}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    style={{
                      width: "32px",
                      height: "32px",
                      border: "none",
                      borderRadius: "50%",
                      cursor: "pointer",
                      padding: "1px",
                    }}
                    title="Custom color"
                  />
                  <input
                    type="text"
                    value={primaryColor || ""}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    placeholder="#FE9D28"
                    style={{
                      width: "88px",
                      padding: "6px 10px",
                      border: "1px solid #e1e3e5",
                      borderRadius: "8px",
                      fontSize: "13px",
                      fontFamily: "monospace",
                      color: "#202223",
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="pm-divider" />

            {/* ── Border Radius ─────────────────────────────── */}
            <div>
              <div className="pm-section-title">Style</div>
              <div style={{ display: "flex", gap: "10px" }}>
                {[
                  { label: "Sharp", value: 0, preview: "2px" },
                  { label: "Soft", value: 8, preview: "8px" },
                  { label: "Round", value: 16, preview: "16px" },
                  { label: "Pill", value: 24, preview: "24px" },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`pm-visual-card ${borderRadius === opt.value ? "selected" : ""}`}
                    onClick={() => setBorderRadius(opt.value)}
                  >
                    <div
                      style={{
                        width: "40px",
                        height: "28px",
                        background:
                          borderRadius === opt.value
                            ? primaryColor || "#FE9D28"
                            : "#e1e3e5",
                        borderRadius: opt.preview,
                        transition: "all 0.15s",
                      }}
                    />
                    <span className="pm-visual-card-label">{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="pm-divider" />

            {/* ── Widget Position ───────────────────────────── */}
            <div>
              <div className="pm-section-title">Widget Position</div>
              <div style={{ display: "flex", gap: "10px" }}>
                {[
                  {
                    label: "Bottom Left",
                    value: "bottom-left",
                    icon: (
                      <div
                        style={{
                          width: "48px",
                          height: "36px",
                          background: "#f6f6f7",
                          borderRadius: "6px",
                          position: "relative",
                          border: "1px solid #e1e3e5",
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            bottom: "4px",
                            left: "4px",
                            width: "12px",
                            height: "12px",
                            borderRadius: "50%",
                            background:
                              widgetPosition === "bottom-left"
                                ? primaryColor || "#FE9D28"
                                : "#c4c4c4",
                          }}
                        />
                      </div>
                    ),
                  },
                  {
                    label: "Bottom Right",
                    value: "bottom-right",
                    icon: (
                      <div
                        style={{
                          width: "48px",
                          height: "36px",
                          background: "#f6f6f7",
                          borderRadius: "6px",
                          position: "relative",
                          border: "1px solid #e1e3e5",
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            bottom: "4px",
                            right: "4px",
                            width: "12px",
                            height: "12px",
                            borderRadius: "50%",
                            background:
                              widgetPosition === "bottom-right"
                                ? primaryColor || "#FE9D28"
                                : "#c4c4c4",
                          }}
                        />
                      </div>
                    ),
                  },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`pm-visual-card ${widgetPosition === opt.value ? "selected" : ""}`}
                    onClick={() =>
                      setWidgetPosition(opt.value as WidgetPosition)
                    }
                  >
                    {opt.icon}
                    <span className="pm-visual-card-label">{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="pm-divider" />

            {/* ── Chatbot Name & Greeting ───────────────────── */}
            <div>
              <div className="pm-section-title">Chatbot</div>
              <BlockStack gap="300">
                <TextField
                  label="Greeting message"
                  value={greetingText}
                  onChange={(val) => {
                    setGreetingText(val);
                    setErrors((prev) => ({ ...prev, greetingText: undefined }));
                  }}
                  placeholder="Hi! Tell me about your pet 🐾"
                  helpText={`${greetingText.length}/200 characters`}
                  maxLength={200}
                  autoComplete="off"
                  error={errors.greetingText}
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
                  helpText="Leave blank to use the default 🐾 avatar."
                />
              </BlockStack>
            </div>

            <div className="pm-divider" />

            {/* ── Product Eligibility ───────────────────────── */}
            <div>
              <div className="pm-section-title">Product Eligibility</div>
              <BlockStack gap="300">
                <Select
                  label="Which products can Lumi recommend?"
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
                    <div onKeyDown={handleTagKeyDown}>
                      <TextField
                        label="Product tags"
                        value={tagInput}
                        onChange={setTagInput}
                        placeholder="Type a tag and press Enter"
                        autoComplete="off"
                        error={errors.eligibilityTags}
                        connectedRight={
                          <Button onClick={addTag} disabled={!tagInput.trim()}>
                            Add
                          </Button>
                        }
                      />
                    </div>
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
                    autoComplete="off"
                    error={errors.eligibilityCollectionIds}
                    helpText="Comma-separated Shopify collection IDs."
                  />
                )}
              </BlockStack>
            </div>

            <div className="pm-divider" />

            {/* ── Store Knowledge ───────────────────────────── */}
            <div>
              <div className="pm-section-title">Store Knowledge</div>
              <BlockStack gap="300">
                <TextField
                  label="FAQ, Policies & Shipping"
                  value={storeKnowledge}
                  onChange={setStoreKnowledge}
                  multiline={5}
                  autoComplete="off"
                  placeholder="e.g. Free shipping over $50. Returns accepted within 30 days..."
                  helpText="The AI will use this to answer customer questions about your store."
                />
                <TextField
                  label="Custom AI Instructions"
                  value={customInstructions}
                  onChange={setCustomInstructions}
                  multiline={3}
                  autoComplete="off"
                  placeholder="e.g. Always be friendly. Never suggest medical diagnoses."
                  helpText="Optional instructions to shape how Lumi behaves."
                />
              </BlockStack>
            </div>
          </div>

          {/* ── Save Footer ─────────────────────────────────────────────── */}
          <div
            style={{
              padding: "16px 24px",
              borderTop: "1px solid #f1f2f3",
              background: "white",
              position: "sticky",
              bottom: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
            }}
          >
            {showSuccess && (
              <div
                className="anim-success"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  color: "#108043",
                  fontSize: "13px",
                  fontWeight: 600,
                }}
              >
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  style={{ width: "16px", height: "16px" }}
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
                Saved
              </div>
            )}
            <div
              style={{
                marginLeft: "auto",
                display: "flex",
                gap: "10px",
                alignItems: "center",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  const iframe = document.getElementById(
                    "widget-preview-iframe",
                  ) as HTMLIFrameElement;
                  if (iframe) iframe.src = iframe.src;
                }}
                style={{
                  padding: "8px 14px",
                  borderRadius: "8px",
                  border: "1px solid #e1e3e5",
                  background: "white",
                  fontSize: "13px",
                  color: "#202223",
                  cursor: "pointer",
                  fontWeight: 500,
                }}
              >
                ↺ Refresh Preview
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={
                  isSaving && fetcher.formData?.get("intent") === "save"
                }
                style={{
                  padding: "8px 20px",
                  borderRadius: "8px",
                  border: "none",
                  background: primaryColor || "#FE9D28",
                  color: "white",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                  opacity: isSaving ? 0.7 : 1,
                  transition: "opacity 0.15s",
                }}
              >
                {isSaving && fetcher.formData?.get("intent") === "save"
                  ? "Saving..."
                  : "Save settings"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
