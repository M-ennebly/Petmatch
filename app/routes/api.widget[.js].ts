import type { LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const baseUrl = url.origin.replace(/^http:/, "https:");

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

      // Live preview updates from settings panel
      window.addEventListener('message', function(event) {
          if (!event.data || event.data.type !== 'PM_PREVIEW_UPDATE') return;
          const d = event.data;
          
          if (d.primaryColor) {
              document.documentElement.style.setProperty('--pm-primary', d.primaryColor);
          }
          if (typeof d.borderRadius === 'number') {
              document.documentElement.style.setProperty('--pm-radius', d.borderRadius + 'px');
          }
          if (d.widgetPosition) {
              const widget = document.getElementById('pm-chat-widget');
              const panel = document.getElementById('pm-chat-panel');
              if (widget) {
                  if (d.widgetPosition === 'bottom-left') {
                      widget.style.left = '24px';
                      widget.style.right = 'unset';
                  } else {
                      widget.style.right = '24px';
                      widget.style.left = 'unset';
                  }
              }
              if (panel) {
                  if (d.widgetPosition === 'bottom-left') {
                      panel.style.left = '0';
                      panel.style.right = 'unset';
                      panel.style.transformOrigin = 'bottom left';
                  } else {
                      panel.style.right = '0';
                      panel.style.left = 'unset';
                      panel.style.transformOrigin = 'bottom right';
                  }
              }
          }
      });
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

      function initWidget() {
          // Position logic
          const isLeft = config.widgetPosition === "bottom-left";
      const horizPos = isLeft ? 'left: 20px;' : 'right: 20px;';
      const panelOrig = isLeft ? 'transform-origin: bottom left;' : 'transform-origin: bottom right;';

      // Inject CSS
      const style = document.createElement("style");
      style.textContent = \`
        :root {
          --pm-primary: \${config.primaryColor};
          --pm-radius: \${config.borderRadius}px;
          --pm-font: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          --pm-shadow: 0 20px 60px rgba(0,0,0,0.12), 0 4px 16px rgba(0,0,0,0.08);
          --pm-shadow-sm: 0 2px 8px rgba(0,0,0,0.08);
        }

        #pm-chat-widget {
          position: fixed;
          bottom: 24px;
          \${horizPos}
          z-index: 999999;
          font-family: var(--pm-font);
        }

        #pm-chat-btn {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: var(--pm-primary);
          color: white;
          border: none;
          box-shadow: 0 4px 16px rgba(0,0,0,0.2);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
          position: relative;
        }

        #pm-chat-btn:hover {
          transform: scale(1.08);
          box-shadow: 0 8px 24px rgba(0,0,0,0.25);
        }

        #pm-chat-btn::after {
          content: '';
          position: absolute;
          top: -3px; right: -3px;
          width: 12px; height: 12px;
          background: #22c55e;
          border-radius: 50%;
          border: 2px solid white;
        }

        #pm-chat-panel {
          position: absolute;
          bottom: 72px;
          \${isLeft ? 'left: 0;' : 'right: 0;'}
          \${panelOrig}
          width: 360px;
          height: 560px;
          background: #ffffff;
          border-radius: var(--pm-radius);
          box-shadow: var(--pm-shadow);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.25s ease, transform 0.25s ease;
          transform: translateY(16px) scale(0.96);
          border: 1px solid rgba(0,0,0,0.06);
        }

        #pm-chat-panel.pm-open {
          opacity: 1;
          pointer-events: all;
          transform: translateY(0) scale(1);
        }

        #pm-chat-header {
          background: var(--pm-primary);
          color: white;
          padding: 16px 18px;
          border-radius: var(--pm-radius) var(--pm-radius) 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-shrink: 0;
        }

        .pm-header-left {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .pm-header-avatar {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: rgba(255,255,255,0.25);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          flex-shrink: 0;
          overflow: hidden;
        }

        .pm-header-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .pm-header-info {
          display: flex;
          flex-direction: column;
          gap: 1px;
        }

        .pm-header-name {
          font-weight: 600;
          font-size: 15px;
          letter-spacing: -0.2px;
        }

        .pm-header-status {
          font-size: 11px;
          opacity: 0.85;
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .pm-header-status::before {
          content: '';
          width: 6px;
          height: 6px;
          background: #86efac;
          border-radius: 50%;
          display: inline-block;
        }

        #pm-chat-close {
          background: rgba(255,255,255,0.15);
          border: none;
          color: white;
          cursor: pointer;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          transition: background 0.15s;
          flex-shrink: 0;
        }

        #pm-chat-close:hover {
          background: rgba(255,255,255,0.25);
        }

        #pm-chat-messages {
          flex: 1;
          padding: 16px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
          background: #fafafa;
          scrollbar-width: thin;
          scrollbar-color: #e5e7eb transparent;
        }

        #pm-chat-messages::-webkit-scrollbar {
          width: 4px;
        }

        #pm-chat-messages::-webkit-scrollbar-track {
          background: transparent;
        }

        #pm-chat-messages::-webkit-scrollbar-thumb {
          background: #e5e7eb;
          border-radius: 4px;
        }

        .pm-msg-wrapper {
          display: flex;
          gap: 8px;
          align-items: flex-end;
          max-width: 88%;
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
          background: var(--pm-primary);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          font-weight: 600;
          color: white;
          letter-spacing: -0.3px;
        }

        .pm-welcome {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 24px 16px 16px;
          text-align: center;
          gap: 6px;
        }
        .pm-welcome-avatar {
          width: 56px;
          height: 56px;
          background: var(--pm-primary);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 26px;
          margin-bottom: 4px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        .pm-welcome-name {
          font-size: 17px;
          font-weight: 700;
          color: #111827;
          letter-spacing: -0.3px;
        }
        .pm-welcome-tagline {
          font-size: 13px;
          color: #6b7280;
          line-height: 1.4;
        }

        .pm-msg {
          padding: 10px 14px;
          border-radius: var(--pm-radius);
          font-size: 13px;
          line-height: 1.45;
          word-wrap: break-word;
          max-width: 100%;
        }

        .pm-msg-user {
          background: var(--pm-primary);
          color: white;
          border-bottom-right-radius: 4px;
          font-weight: 450;
        }

        .pm-msg-bot {
          background: white;
          color: #1a1a1a;
          border-bottom-left-radius: 4px;
          box-shadow: var(--pm-shadow-sm);
          border: 1px solid rgba(0,0,0,0.05);
        }

        .pm-msg-img {
          max-width: 100%;
          border-radius: var(--pm-radius);
          margin-top: 8px;
        }

        .pm-typing {
          display: flex;
          gap: 4px;
          align-items: center;
          padding: 12px 16px;
        }

        .pm-typing span {
          width: 7px;
          height: 7px;
          background: #d1d5db;
          border-radius: 50%;
          animation: pm-bounce 1.2s infinite;
        }

        .pm-typing span:nth-child(2) { animation-delay: 0.2s; }
        .pm-typing span:nth-child(3) { animation-delay: 0.4s; }

        @keyframes pm-bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-5px); background: var(--pm-primary); }
        }

        #pm-chat-input-area {
          padding: 12px 14px;
          background: white;
          border-top: 1px solid #f0f0f0;
          display: flex;
          gap: 8px;
          align-items: center;
          flex-shrink: 0;
        }

        #pm-chat-input {
          flex: 1;
          border: 1.5px solid #e5e7eb;
          border-radius: var(--pm-radius);
          padding: 9px 16px;
          outline: none;
          font-size: 14px;
          font-family: var(--pm-font);
          background: #f9fafb;
          transition: border-color 0.15s, background 0.15s;
          color: #1a1a1a;
        }

        #pm-chat-input::placeholder {
          color: #9ca3af;
        }

        #pm-chat-input:focus {
          border-color: var(--pm-primary);
          background: white;
        }

        .pm-icon-btn {
          background: transparent;
          border: none;
          color: #9ca3af;
          cursor: pointer;
          border-radius: 50%;
          width: 34px;
          height: 34px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.15s, color 0.15s;
          flex-shrink: 0;
        }

        .pm-icon-btn:hover {
          background: #f3f4f6;
          color: var(--pm-primary);
        }

        #pm-chat-send {
          background: var(--pm-primary);
          border: none;
          color: white;
          cursor: pointer;
          border-radius: 50%;
          width: 34px;
          height: 34px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.15s, opacity 0.15s;
          flex-shrink: 0;
        }

        #pm-chat-send:hover {
          transform: scale(1.08);
          opacity: 0.9;
        }

        .pm-rec-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
          margin-top: 10px;
        }

        .pm-rec-card {
          display: flex;
          flex-direction: row;
          background: white;
          border: 1px solid #f0f0f0;
          border-radius: var(--pm-radius);
          overflow: hidden;
          text-decoration: none;
          color: inherit;
          box-shadow: 0 2px 8px rgba(0,0,0,0.06);
          transition: box-shadow 0.2s, transform 0.2s;
        }

        .pm-rec-card:hover {
          box-shadow: 0 4px 16px rgba(0,0,0,0.1);
          transform: translateY(-1px);
        }

        .pm-rec-img {
          width: 80px;
          height: 80px;
          object-fit: cover;
          background: #f9fafb;
          flex-shrink: 0;
        }

        .pm-rec-info {
          padding: 10px 12px;
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        .pm-rec-title {
          font-weight: 600;
          font-size: 13px;
          color: #111827;
          margin: 0 0 3px 0;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          line-height: 1.4;
        }

        .pm-rec-price {
          font-size: 13px;
          font-weight: 600;
          color: var(--pm-primary);
          margin-bottom: 8px;
        }

        .pm-rec-actions {
          display: flex;
          gap: 6px;
        }

        .pm-rec-btn {
          flex: 1;
          padding: 6px 0;
          text-align: center;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          text-decoration: none;
          transition: opacity 0.15s;
          border: none;
        }

        .pm-rec-btn:hover {
          opacity: 0.85;
        }

        .pm-btn-view {
          background: #f3f4f6;
          color: #374151;
        }

        .pm-btn-add {
          background: var(--pm-primary);
          color: white;
        }

        .pm-quick-replies {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 10px;
        }

        .pm-quick-reply-btn {
          background: white;
          border: 1.5px solid var(--pm-primary);
          color: var(--pm-primary);
          padding: 6px 14px;
          border-radius: 20px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
          font-family: var(--pm-font);
        }

        .pm-quick-reply-btn:hover {
          background: var(--pm-primary);
          color: white;
        }

        .pm-powered-by {
          text-align: center;
          font-size: 10px;
          color: #d1d5db;
          padding: 6px 0 2px;
          letter-spacing: 0.3px;
        }
      \`;
      document.head.appendChild(style);

      // Inject HTML
      const container = document.createElement("div");
      container.id = "pm-chat-widget";
      container.innerHTML = \`
        <div id="pm-chat-panel">
          <div id="pm-chat-header">
            <div class="pm-header-left">
              <div class="pm-header-avatar">
                \${config.avatarUrl ? \`<img src="\${config.avatarUrl}" alt="Lumi" />\` : '🐾'}
              </div>
              <div class="pm-header-info">
                <span class="pm-header-name">PetMatch AI</span>
                <span class="pm-header-status">Online · Here to help</span>
              </div>
            </div>
            <button id="pm-chat-close">×</button>
          </div>
          <div id="pm-chat-messages"></div>
          <div id="pm-chat-input-area">
            <input type="text" id="pm-chat-input" placeholder="Ask about your pet..." />
            <button id="pm-chat-send" title="Send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            </button>
          </div>
        </div>
        <button id="pm-chat-btn">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        </button>
      \`;
      document.body.appendChild(container);

      const btn = document.getElementById("pm-chat-btn");
      const panel = document.getElementById("pm-chat-panel");
      const closeBtn = document.getElementById("pm-chat-close");
      const messagesContainer = document.getElementById("pm-chat-messages");
      const input = document.getElementById("pm-chat-input");
      const sendBtn = document.getElementById("pm-chat-send");

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
                avatar.textContent = "🐾";
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
        
        const avatar = document.createElement("div");
        avatar.className = "pm-avatar";
        avatar.textContent = "🐾";
        
        const typing = document.createElement("div");
        typing.className = "pm-msg pm-msg-bot pm-typing";
        typing.innerHTML = "<span></span><span></span><span></span>";
        
        wrap.appendChild(avatar);
        wrap.appendChild(typing);
        
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
              messagesContainer.innerHTML = \`<div class="pm-welcome" id="pm-welcome-card">
                <div class="pm-welcome-avatar">🐾</div>
                <div class="pm-welcome-name">Lumi</div>
                <div class="pm-welcome-tagline">Your personal pet shopping assistant</div>
              </div>\`;
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
        
        const welcomeCard = document.getElementById("pm-welcome-card");
        if (welcomeCard) welcomeCard.remove();

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
      } // end function initWidget

      // Initialize after page load
      if (document.readyState === "complete" || document.readyState === "interactive") {
        initWidget();
      } else {
        document.addEventListener("DOMContentLoaded", initWidget);
      }

    })();
  `;

  return new Response(scriptContent, {
    headers: {
      "Content-Type": "application/javascript",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
