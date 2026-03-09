import type { LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const baseUrl = url.origin.replace(/^http:/, 'https:');

  const scriptContent = `
    (async function() {
      // Chat Widget Setup — derive baseUrl from script src (survives tunnel changes)
      var _cs = document.currentScript && document.currentScript.src;
      var baseUrl = _cs ? new URL(_cs).origin : "${baseUrl}";
      const shopDomain = window.Shopify ? window.Shopify.shop : window.location.hostname;

      // Fetch config
      let config = {
          primaryColor: "#22c55e",
          borderRadius: 16,
          position: "bottom-right",
          greetingText: "Hi! Tell me about your pet and what you’re looking for.",
          avatarUrl: null
      };
      try {
          const cfgRes = await fetch(\`\${baseUrl}/api/widget-config?shop=\${shopDomain}\`, {
              headers: { 'ngrok-skip-browser-warning': 'true' }
          });
          if (cfgRes.ok) {
              config = await cfgRes.json();
          }
      } catch (e) {
          console.warn("Could not load widget config", e);
      }

      // Handle browser UUID
      let browserId = localStorage.getItem("petmatch_browser_id");
      if (!browserId) {
         browserId = crypto.randomUUID ? crypto.randomUUID() : 'id_' + Math.random().toString(36).substr(2, 9);
         localStorage.setItem("petmatch_browser_id", browserId);
      }

      let sessionId = null;
      let isOpen = false;

      async function trackEvent(eventType, metadata = {}) {
        try {
            await fetch(baseUrl + "/api/event", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "ngrok-skip-browser-warning": "true"
                },
                body: JSON.stringify({
                    shop: shopDomain,
                    sessionId: sessionId || browserId,
                    eventType,
                    metadata
                })
            });
        } catch (e) {
            console.warn("Event tracking failed", e);
        }
      }

      // Position logic
      const isLeft = config.position === "bottom-left";
      const horizPos = isLeft ? 'left: 20px;' : 'right: 20px;';
      const panelOrig = isLeft ? 'transform-origin: bottom left;' : 'transform-origin: bottom right;';

      // Inject CSS
      const style = document.createElement("style");
      style.textContent = \`
        :root {
            --pm-primary: \${config.primaryColor};
            --pm-radius: \${config.borderRadius}px;
        }
        #pm-chat-widget {
          position: fixed;
          bottom: 20px;
          \${horizPos}
          z-index: 999999;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }
        #pm-chat-btn {
          width: 60px;
          height: 60px;
          border-radius: 50%;
          background: var(--pm-primary);
          color: white;
          border: none;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 24px;
          transition: transform 0.2s;
        }
        #pm-chat-btn:hover {
          transform: scale(1.05);
        }
        #pm-chat-panel {
          position: absolute;
          bottom: 80px;
          \${isLeft ? 'left: 0;' : 'right: 0;'}
          \${panelOrig}
          width: 350px;
          height: 500px;
          background: white;
          border-radius: var(--pm-radius);
          box-shadow: 0 8px 24px rgba(0,0,0,0.15);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s, transform 0.2s;
          transform: translateY(10px) scale(0.95);
        }
        #pm-chat-panel.pm-open {
          opacity: 1;
          pointer-events: all;
          transform: translateY(0) scale(1);
        }
        #pm-chat-header {
          background: var(--pm-primary);
          color: white;
          padding: 16px;
          font-weight: 600;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-radius: var(--pm-radius) var(--pm-radius) 0 0;
        }
        #pm-chat-close {
          background: transparent;
          border: none;
          color: white;
          cursor: pointer;
          font-size: 20px;
        }
        #pm-chat-messages {
          flex: 1;
          padding: 16px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 12px;
          background: #f9fafb;
        }
        .pm-msg-wrapper {
          display: flex;
          gap: 8px;
          align-items: flex-end;
          max-width: 85%;
        }
        .pm-msg-wrapper-user {
          align-self: flex-end;
          flex-direction: row-reverse;
        }
        .pm-msg-wrapper-bot {
          align-self: flex-start;
        }
        .pm-avatar {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          flex-shrink: 0;
          object-fit: cover;
          background: #e1e3e5;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          color: #6d7175;
        }
        .pm-msg {
          padding: 10px 14px;
          border-radius: var(--pm-radius);
          font-size: 14px;
          line-height: 1.4;
          word-wrap: break-word;
        }
        .pm-msg-user {
          background: var(--pm-primary);
          color: white;
          border-bottom-right-radius: 4px;
        }
        .pm-msg-bot {
          background: white;
          color: #111827;
          border-bottom-left-radius: 4px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        .pm-msg-img {
          max-width: 100%;
          border-radius: 8px;
          margin-top: 8px;
        }
        #pm-chat-input-area {
          padding: 12px;
          background: white;
          border-top: 1px solid #e5e7eb;
          display: flex;
          gap: 8px;
          align-items: center;
          border-radius: 0 0 var(--pm-radius) var(--pm-radius);
        }
        #pm-chat-input {
          flex: 1;
          border: 1px solid #d1d5db;
          border-radius: 20px;
          padding: 8px 16px;
          outline: none;
          font-size: 14px;
        }
        #pm-chat-input:focus {
          border-color: var(--pm-primary);
        }
        .pm-icon-btn {
          background: transparent;
          border: none;
          color: #6b7280;
          cursor: pointer;
          border-radius: 50%;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }
        .pm-icon-btn:hover {
          background: #f3f4f6;
          color: var(--pm-primary);
        }
        .pm-rec-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-top: 12px;
        }
        .pm-rec-card {
          display: flex;
          flex-direction: row;
          background: white;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          overflow: hidden;
          text-decoration: none;
          color: inherit;
        }
        .pm-rec-img {
          width: 80px;
          height: 80px;
          object-fit: cover;
          background: #f9fafb;
        }
        .pm-rec-info {
          padding: 8px 12px;
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
        }
        .pm-rec-title {
          font-weight: 500;
          font-size: 13px;
          color: #111827;
          margin: 0 0 4px 0;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .pm-rec-price {
          font-size: 12px;
          color: #4b5563;
          margin-bottom: 8px;
        }
        .pm-rec-actions {
          display: flex;
          gap: 8px;
        }
        .pm-rec-btn {
          flex: 1;
          padding: 6px 0;
          text-align: center;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          text-decoration: none;
        }
        .pm-btn-view {
          background: #f3f4f6;
          color: #374151;
        }
        .pm-btn-add {
          background: var(--pm-primary);
          color: white;
          border: none;
        }
        .pm-quick-replies {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 8px;
        }
        .pm-quick-reply-btn {
          background: white;
          border: 1.5px solid var(--pm-primary);
          color: var(--pm-primary);
          padding: 6px 12px;
          border-radius: 16px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
        }
        .pm-quick-reply-btn:hover {
          background: var(--pm-primary);
          color: white;
        }
      \`;
      document.head.appendChild(style);

      // Inject HTML
      const container = document.createElement("div");
      container.id = "pm-chat-widget";
      container.innerHTML = \`
        <div id="pm-chat-panel">
          <div id="pm-chat-header">
            <span>PetMatch AI</span>
            <button id="pm-chat-close">×</button>
          </div>
          <div id="pm-chat-messages"></div>
          <div id="pm-chat-input-area">
            <input type="file" id="pm-chat-file" accept="image/*" style="display:none;" />
            <button class="pm-icon-btn" id="pm-chat-attach" title="Attach Photo">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            </button>
            <input type="text" id="pm-chat-input" placeholder="Type a message..." />
            <button class="pm-icon-btn" id="pm-chat-send" title="Send">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            </button>
          </div>
        </div>
        <button id="pm-chat-btn">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        </button>
      \`;
      document.body.appendChild(container);

      const btn = document.getElementById("pm-chat-btn");
      const panel = document.getElementById("pm-chat-panel");
      const closeBtn = document.getElementById("pm-chat-close");
      const messagesContainer = document.getElementById("pm-chat-messages");
      const input = document.getElementById("pm-chat-input");
      const sendBtn = document.getElementById("pm-chat-send");
      const attachBtn = document.getElementById("pm-chat-attach");
      const fileInput = document.getElementById("pm-chat-file");

      function togglePanel() {
        isOpen = !isOpen;
        if (isOpen) {
          panel.classList.add("pm-open");
          trackEvent("widget_opened");
          if (!sessionId) loadHistory();
          input.focus();
        } else {
          panel.classList.remove("pm-open");
        }
      }

      btn.addEventListener("click", togglePanel);
      closeBtn.addEventListener("click", togglePanel);

      messagesContainer.addEventListener("click", (e) => {
        if (e.target.classList.contains("pm-btn-view")) {
            trackEvent("product_clicked", { 
                href: e.target.href,
                handle: e.target.getAttribute("data-handle"),
                title: e.target.getAttribute("data-title")
            });
        }
        if (e.target.classList.contains("pm-btn-add")) {
            trackEvent("add_to_cart_clicked", {
                variantId: e.target.getAttribute("data-id"),
                title: e.target.getAttribute("data-title")
            });
        }
      });

      function appendMessage(msg) {
        const wrap = document.createElement("div");
        wrap.className = "pm-msg-wrapper " + (msg.role === "user" ? "pm-msg-wrapper-user" : "pm-msg-wrapper-bot");

        if (msg.role === "bot") {
            const avatar = document.createElement(config.avatarUrl ? "img" : "div");
            avatar.className = "pm-avatar";
            if (config.avatarUrl) {
                avatar.src = config.avatarUrl;
            } else {
                avatar.textContent = "PM"; // PM for PetMatch initials
            }
            wrap.appendChild(avatar);
        }

        const div = document.createElement("div");
        div.className = "pm-msg " + (msg.role === "user" ? "pm-msg-user" : "pm-msg-bot");
        
        if (msg.content) {
          const text = document.createElement("div");
          text.textContent = msg.content;
          div.appendChild(text);
        }

        if (msg.imageUrl) {
          const img = document.createElement("img");
          img.src = msg.imageUrl;
          img.className = "pm-msg-img";
          div.appendChild(img);
        }

        if (msg.recommendations && msg.recommendations.length > 0) {
          const recList = document.createElement("div");
          recList.className = "pm-rec-list";

          msg.recommendations.forEach(rec => {
            const card = document.createElement("div");
            card.className = "pm-rec-card";

            const imgSrc = rec.featuredImageUrl || "https://cdn.shopify.com/s/images/admin/no-image-large.gif";
            const priceText = rec.priceMin === rec.priceMax ? \`$\${rec.priceMin}\` : \`$\${rec.priceMin} - $\${rec.priceMax}\`;
            
            // Wait, Shopify storefront Add to Cart can be an absolute link to /cart/add
            let addToCartHtml = "";
            if (rec.firstVariantId) {
                addToCartHtml = \`<button class="pm-rec-btn pm-btn-add" data-id="\${rec.firstVariantId}" data-title="\${rec.title}" onclick="window.location.href='/cart/add?id=\${rec.firstVariantId}&quantity=1'">Add to cart</button>\`;
            }

            card.innerHTML = \`
              <img src="\${imgSrc}" class="pm-rec-img" alt="\${rec.title}" />
              <div class="pm-rec-info">
                <div class="pm-rec-title">\${rec.title}</div>
                <div class="pm-rec-price">\${priceText}</div>
                <div class="pm-rec-actions">
                  <a href="/products/\${rec.handle}" data-handle="\${rec.handle}" data-title="\${rec.title}" class="pm-rec-btn pm-btn-view" target="_blank">View</a>
                  \${addToCartHtml}
                </div>
              </div>
            \`;
            recList.appendChild(card);
          });

          div.appendChild(recList);
        }

        // Quick reply buttons
        if (msg.quickReplies && msg.quickReplies.length > 0) {
          const qrContainer = document.createElement("div");
          qrContainer.className = "pm-quick-replies";
          msg.quickReplies.forEach(function(label) {
            const btn = document.createElement("button");
            btn.className = "pm-quick-reply-btn";
            btn.textContent = label;
            btn.addEventListener("click", function() {
              // Remove quick reply buttons after selection
              qrContainer.remove();
              // Send the quick reply text as a message
              input.value = label;
              sendMessage();
            });
            qrContainer.appendChild(btn);
          });
          div.appendChild(qrContainer);
        }

        wrap.appendChild(div);
        messagesContainer.appendChild(wrap);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }

      function showTyping() {
        const wrap = document.createElement("div");
        wrap.className = "pm-msg-wrapper pm-msg-wrapper-bot";
        wrap.id = "pm-typing-indicator";
        
        const avatar = document.createElement(config.avatarUrl ? "img" : "div");
        avatar.className = "pm-avatar";
        if (config.avatarUrl) avatar.src = config.avatarUrl;
        else avatar.textContent = "PM";
        
        const div = document.createElement("div");
        div.className = "pm-msg pm-msg-bot pm-typing";
        div.textContent = "Typing...";
        
        wrap.appendChild(avatar);
        wrap.appendChild(div);

        messagesContainer.appendChild(wrap);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }

      function hideTyping() {
        const indicator = document.getElementById("pm-typing-indicator");
        if (indicator) indicator.remove();
      }

      async function loadHistory() {
        try {
          const res = await fetch(\`\${baseUrl}/api/chat?shop=\${shopDomain}&browserId=\${browserId}\`, {
            headers: { 'ngrok-skip-browser-warning': 'true' }
          });
          if (res.ok) {
            const data = await res.json();
            sessionId = data.sessionId;
            messagesContainer.innerHTML = "";
            if (data.history && data.history.length > 0) {
              data.history.forEach(appendMessage);
            } else {
              appendMessage({ role: "bot", content: config.greetingText });
            }
          }
        } catch (e) {
          console.error("Failed to load PetMatch history", e);
        }
      }

      async function sendMessage() {
        const text = input.value.trim();
        if (!text) return;

        input.value = "";
        trackEvent("message_sent", { text });
        appendMessage({ role: "user", content: text });
        showTyping();

        try {
          // Single call: chat + recommendations in one response
          const chatRes = await fetch(\`\${baseUrl}/api/chat\`, {
            method: "POST",
            headers: { 
              "Content-Type": "application/json",
              "ngrok-skip-browser-warning": "true" 
            },
            body: JSON.stringify({ shop: shopDomain, browserId, content: text })
          });
          const data = await chatRes.json();
          if (data.sessionId) sessionId = data.sessionId;

          // TRACE: ONE-BRAIN debug (visible in browser DevTools)
          console.log("PETMATCH _debug:", data._debug, "recs:", data.recommendations ? data.recommendations.map(function(p) { return p.handle; }) : []);

          hideTyping();

          // Show bot reply
          if (data.botMessage && data.botMessage.content) {
            appendMessage({
              role: "bot",
              content: data.botMessage.content,
              imageUrl: data.botMessage.imageUrl
            });
          }

          // Show recommendation cards (from same response)
          if (data.recommendations && data.recommendations.length > 0) {
            trackEvent("recommendation_shown", { 
              handles: data.recommendations.map(function(r) { return r.handle; })
            });
            appendMessage({ 
              role: "bot", 
              content: "", 
              recommendations: data.recommendations 
            });
          }

          if (!data.botMessage && (!data.recommendations || data.recommendations.length === 0)) {
            appendMessage({ role: "bot", content: "I'm here to help! Tell me about your pet and what you're looking for." });
          }

        } catch (e) {
          hideTyping();
          appendMessage({ role: "bot", content: "Sorry, I'm having trouble connecting right now." });
        }
      }

      input.addEventListener("keypress", (e) => {
        if (e.key === "Enter") sendMessage();
      });
      sendBtn.addEventListener("click", sendMessage);

      attachBtn.addEventListener("click", () => fileInput.click());
      
      fileInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        appendMessage({ role: "user", content: "Uploading photo..." });
        showTyping();

        const formData = new FormData();
        formData.append("file", file);
        formData.append("shopDomain", shopDomain);
        formData.append("browserId", browserId);

        try {
          const uploadRes = await fetch(\`\${baseUrl}/api/upload\`, {
            method: "POST",
            headers: { "ngrok-skip-browser-warning": "true" },
            body: formData
          });
          const uploadData = await uploadRes.json();
          
          if (uploadData.success && uploadData.imageUrl) {
            trackEvent("image_uploaded", { imageUrl: uploadData.imageUrl });
            const res = await fetch(baseUrl + "/api/chat", {
              method: "POST",
              headers: { 
                "Content-Type": "application/json",
                "ngrok-skip-browser-warning": "true" 
              },
              body: JSON.stringify({ shop: shopDomain, browserId, imageUrl: uploadData.imageUrl })
            });
            const data = await res.json();
            if (data.sessionId) sessionId = data.sessionId;
            
            const msgs = messagesContainer.querySelectorAll('.pm-msg-wrapper-user');
            if(msgs.length > 0) msgs[msgs.length - 1].remove();

            appendMessage({ role: "user", content: "", imageUrl: uploadData.imageUrl });
            
            hideTyping();
            if (data.botMessage) {
              appendMessage({
                role: "bot",
                content: data.botMessage.content,
                quickReplies: data.quickReplies || []
              });
            }
          } else {
            throw new Error("Upload failed");
          }
        } catch (e) {
          hideTyping();
          appendMessage({ role: "bot", content: "Sorry, I couldn't upload that photo." });
        }
        
        fileInput.value = "";
      });
    })();
  `;

  return new Response(scriptContent, {
    headers: {
      "Content-Type": "application/javascript",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
