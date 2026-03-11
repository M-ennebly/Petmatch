import type { LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "petmatch.myshopify.com";
  const baseUrl = url.origin;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(135deg, #f8fafc 0%, #e8edf2 100%);
      height: 100vh;
      overflow: hidden;
      position: relative;
    }
    .fake-content {
      position: absolute;
      top: 32px; left: 24px; right: 24px;
      display: flex; flex-direction: column; gap: 14px;
    }
    .fake-bar { height: 13px; background: #dde1e7; border-radius: 7px; }
    .fake-img { width: 100%; height: 140px; background: #dde1e7; border-radius: 10px; margin-bottom: 6px; }
    .fake-bar.short { width: 35%; }
    .fake-bar.medium { width: 60%; }
    .fake-bar.long { width: 80%; }
  </style>
</head>
<body>
  <div class="fake-content">
    <div class="fake-img"></div>
    <div class="fake-bar long"></div>
    <div class="fake-bar medium"></div>
    <div class="fake-bar short"></div>
    <div class="fake-bar medium"></div>
    <div class="fake-bar long"></div>
  </div>
  <script>window.Shopify = { shop: "${shopDomain}" };</script>
  <script src="${baseUrl}/api/widget.js?shop=${shopDomain}" async></script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
};
