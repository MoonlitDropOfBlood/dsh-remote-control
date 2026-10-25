/**
 * dsh-remote-control — Client half (web bundle).
 *
 * Rendered by the DSH web shell through `window.__ModuleLoader__.load`. Registers a
 * "DSH Pocket" page in the Settings panel (`settings.section`) that shows:
 *   - the relay address (editable inline — no file editing required) and the
 *     pairing channel, plus the link status,
 *   - the pairing QR code (inline SVG produced by the Host half),
 *   - the actions: save the relay address, rotate the pairing key and
 *     hide / show the pairing.
 *
 * The phone pairing flow is unchanged: the QR still encodes the same
 * `dshrc://pair?…` URI as before (contract §3.5) — only the entry point moved
 * from the `/remote-pairing` command into this settings page (v1.1.x).
 *
 * Host communication goes through the `remoteControl` Remote namespace
 * (`ctx.remote.remoteControl.getPairing() / setRelayUrl(url) / rotateSecret() /
 * setHidden(hidden)`), published by the Host half in `index.js`.
 */
/**
 * This package's client-module id. It is both the `__ModuleLoader__.load` id and
 * the HMR style owner (`data-plugin`) — client-modules keys style ownership off the
 * registered id, so the two must stay the same string.
 */
// COMBO-SAFETY (2026-10-24 production incident): the DSH web server concatenates
// every web client bundle into ONE combo <script> with NO scope wrapping
// (client-modules buildComboScript). Any top-level const/let/class would collide
// with the same name in another bundle (ours collided with token-stats' const
// CLIENT_BUNDLE_ID and killed the whole combo). The whole file therefore lives
// inside this IIFE: zero top-level declarations beyond the wrapper itself.
(() => {
const CLIENT_BUNDLE_ID = "@duke-dsh-plugins/dsh-remote-control";

window.__ModuleLoader__.load({
  id: CLIENT_BUNDLE_ID,
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // ==== BEGIN GENERATED ICON (scripts/sync-client-icon.mjs) ====
// Auto-generated from icon.svg — run `node scripts/sync-client-icon.mjs` after changing the icon.
const CLIENT_ICON_MASK_URI =
  "data:image/svg+xml,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox%3D%228 8 32 34%22 fill%3D%22none%22%3E%0A  %0A  %0A  %0A  %3Cg fill%3D%22none%22 stroke%3D%22%23fff%22 stroke-width%3D%222.8%22 stroke-linecap%3D%22round%22 stroke-linejoin%3D%22round%22%3E%0A    %3Cpath d%3D%22M10.5 12.5 Q24 15 37.5 12.5 L37.5 27 A10.5 10.5 0 0 1 27 37.5 H21 A10.5 10.5 0 0 1 10.5 27 Z%22%2F%3E%0A    %3Cpath d%3D%22M14 16.6 Q24 18.4 34 16.6%22 stroke-opacity%3D%22.4%22 stroke-width%3D%221.3%22%2F%3E%0A  %3C%2Fg%3E%0A  %3Cg transform%3D%22translate(14.00%2C19.1) scale(0.8636)%22%3E%0A    %3Cpath d%3D%22M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z%22 fill%3D%22%23fff%22%2F%3E%0A  %3C%2Fg%3E%0A%3C%2Fsvg%3E";
// ==== END GENERATED ICON ====

    // ---- CSS (package-owned, mirrors DSH design tokens) --------------------
    const CSS = `
.rc-page{max-width:720px;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.rc-head{display:flex;align-items:center;gap:10px}
.rc-head-title{font-size:16px;font-weight:500;line-height:24px;margin:0;flex:1}
.rc-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.rc-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.rc-dot-online{background:var(--dsw-alias-state-success-primary)}
.rc-dot-offline{background:var(--dsw-alias-state-error-primary)}
.rc-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px}
.rc-card-title{font-size:14px;font-weight:500;line-height:20px;margin:0}
.rc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rc-field{display:flex;flex-direction:column;gap:2px;min-width:0}
.rc-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.rc-value{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.rc-input{box-sizing:border-box;height:30px;flex:1;min-width:240px;font:inherit;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px}
.rc-input:focus{outline:none;border-color:var(--dsw-alias-border-l1)}
.rc-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.rc-qr{display:flex;justify-content:center;padding:8px 0}
.rc-qr svg{width:220px;height:220px;max-width:100%;display:block;background:#fff;border-radius:10px;padding:8px}
.rc-qr-empty{color:var(--dsw-alias-label-secondary);font-size:13px;padding:24px 0;text-align:center}
.rc-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.rc-actions{display:flex;gap:8px;flex-wrap:wrap}
.rc-btn{box-sizing:border-box;height:30px;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:0 14px;font-size:13px;line-height:28px}
.rc-btn:hover{border-color:var(--dsw-alias-border-l1)}
.rc-btn:disabled{opacity:.5;cursor:default}
.rc-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.rc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
.rc-hint{font-size:12px;line-height:18px;min-height:18px;color:var(--dsw-alias-label-secondary)}
.rc-hint-error{color:var(--dsw-alias-state-error-primary)}
.rc-hint-ok{color:var(--dsw-alias-state-success-primary)}
.rc-loading{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary);font-size:13px;padding:24px 0}
.rc-spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);animation:rc-spin .8s linear infinite;flex:none}
@keyframes rc-spin{to{transform:rotate(360deg)}}

/* Settings nav icon: DSH 0.1.x settings.section only projects id/order/label,
   and the settings shell paints a generic gear for every external section
   (client-ui-settings-general's navIcon()). registerSettingsNavIcon marks our
   own nav row; hide the shell's gear and draw this package's whale glyph as a
   currentColor mask so it follows the native nav hover/active colors.
   20px (2026-10-24 user feedback): the mask viewBox is cropped tight to the
   whale+wave, so at 16px the glyph itself rendered only ~9px — too small next
   to the section labels; 20px restores legibility. */
[data-dsh-remote-control-settings-nav]>svg:first-child{display:none}
[data-dsh-remote-control-settings-nav]::before{content:'';flex:none;width:20px;height:20px;background:currentColor;-webkit-mask:url("__ICON_MASK__") center/contain no-repeat;mask:url("__ICON_MASK__") center/contain no-repeat}
`;

    // ---- Settings nav icon --------------------------------------------------
    // DSH 0.1.x does not yet carry an icon through the settings.section
    // registration contract: its shell projects only id/order/label and paints
    // a generic gear for every external section. Mark only this plugin's
    // localized nav row so the CSS above can replace the fallback gear; the
    // disposer clears the marker for HMR / plugin disable.
    const SETTINGS_LABEL = "DSH Pocket";
    const SETTINGS_NAV_MARKER = "data-dsh-remote-control-settings-nav";

    function registerSettingsNavIcon(label) {
      let disposed = false;
      const sync = function () {
        if (disposed) return;
        const currentLabel = String(label).trim();
        const buttons = document.querySelectorAll('[role="dialog"] nav button');
        for (let i = 0; i < buttons.length; i++) {
          const button = buttons[i];
          const text = button.textContent ? button.textContent.trim() : "";
          if (currentLabel.length > 0 && text === currentLabel) {
            button.setAttribute(SETTINGS_NAV_MARKER, "");
          } else {
            button.removeAttribute(SETTINGS_NAV_MARKER);
          }
        }
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return function () {
        disposed = true;
        observer.disconnect();
        const marked = document.querySelectorAll("[" + SETTINGS_NAV_MARKER + "]");
        for (let i = 0; i < marked.length; i++) marked[i].removeAttribute(SETTINGS_NAV_MARKER);
      };
    }

    // ---- Client Remote contribution ----------------------------------------
    // The browser-side `remote.remoteControl` service only exists after this
    // module mounts its namespace via ctx.remote.$mount(): dsh-api-remotes'
    // client assembly mounts only the official namespaces, so a plugin must
    // mount its own. Mirrors the invocations in typert.host.js (id,
    // service/namespace/method). zod is not requirable in the browser module
    // loader, so codecs use passthrough schemas — but they still need a
    // create() factory: the client-side typert remote store REJECTS strict
    // codecs without one ("has no create() factory" → dead Remote namespace).
    const passthrough = () => ({ parse: (v) => v });
    const createPassthrough = () => passthrough();
    const CLIENT_REMOTE = {
      package: "dsh-remote-control",
      descriptors: [
        {
          id: "dsh-remote-control#remoteControl/getPairing",
          service: "remoteControl",
          namespace: "remoteControl",
          method: "getPairing",
          invocation: { kind: "direct" },
          parameters: [],
          result: {
            mode: "strict",
            typeSymbol: "dsh-remote-control#PairingResult",
            schema: passthrough(),
            create: createPassthrough,
          },
        },
        {
          id: "dsh-remote-control#remoteControl/rotateSecret",
          service: "remoteControl",
          namespace: "remoteControl",
          method: "rotateSecret",
          invocation: { kind: "direct" },
          parameters: [],
          result: {
            mode: "strict",
            typeSymbol: "dsh-remote-control#PairingResult",
            schema: passthrough(),
            create: createPassthrough,
          },
        },
        {
          id: "dsh-remote-control#remoteControl/setHidden",
          service: "remoteControl",
          namespace: "remoteControl",
          method: "setHidden",
          invocation: { kind: "direct" },
          parameters: [
            {
              name: "hidden",
              wire: "hidden",
              source: "json",
              codec: {
                mode: "strict",
                typeSymbol: "dsh-remote-control#remoteControl/setHidden:hidden",
                schema: passthrough(),
                create: createPassthrough,
              },
            },
          ],
          result: {
            mode: "strict",
            typeSymbol: "dsh-remote-control#PairingResult",
            schema: passthrough(),
            create: createPassthrough,
          },
        },
        {
          id: "dsh-remote-control#remoteControl/setRelayUrl",
          service: "remoteControl",
          namespace: "remoteControl",
          method: "setRelayUrl",
          invocation: { kind: "direct" },
          parameters: [
            {
              name: "url",
              wire: "url",
              source: "json",
              codec: {
                mode: "strict",
                typeSymbol: "dsh-remote-control#remoteControl/setRelayUrl:url",
                schema: passthrough(),
                create: createPassthrough,
              },
            },
          ],
          result: {
            mode: "strict",
            typeSymbol: "dsh-remote-control#PairingResult",
            schema: passthrough(),
            create: createPassthrough,
          },
        },
      ],
    };

    /**
     * 双层信封解包（2026-10-24 修复二维码/频道/中继地址全空不显示）：
     * remote 网关返回 res.value = host 方法的 { ok, value|error } —— 网关在
     * 宿主返回外又包了一层，必须拆两层（token-stats unwrapRemote 同款，其注释
     * 原话「双层信封解包」）。此前单层拆包把内层信封整个当成了数据，页面
     * relayUrl/channel/hidden/qrSvg 全部 undefined → 渲染全空；而宿主侧
     * 真实生效（密钥轮换/隐藏/保存地址都落了盘），症状是「按钮有效但界面无反应」。
     * 兼容：若某路径未包第二层（res.value 没有 ok 字段），按单层处理。
     */
    function unwrapRemote(res) {
      if (!res || typeof res !== "object") {
        return { ok: false, message: "宿主返回了无法识别的结果。" };
      }
      const inner =
        res.value && typeof res.value === "object" && "ok" in res.value
          ? res.value
          : res;
      if (inner.ok === true) return { ok: true, value: inner.value || {} };
      const err = inner.error || {};
      return { ok: false, message: err.message || err.code || "未知错误" };
    }

    /**
     * 中继进程托管状态 → 一行中文（v1.1.1）。
     * 宿主没给这个字段（旧插件）时显示「由外部管理」，不报错。
     * @param {any} snap 宿主返回的 relayProcess 快照
     * @returns {string}
     */
    function relayProcessText(snap) {
      if (!snap || typeof snap !== "object") return "由外部管理";
      if (snap.managed === true) {
        if (snap.running === true) {
          const pid = typeof snap.pid === "number" && snap.pid > 0 ? "（pid " + snap.pid + "）" : "";
          return "插件托管 · 运行中" + pid;
        }
        return "插件托管 · 未运行（将自动重拉）";
      }
      // 端口上已有服务但不是插件起的 → 外部中继（插件不干预）
      if (snap.external === true) {
        const port = typeof snap.port === "number" && snap.port > 0 ? "（端口 " + snap.port + "）" : "";
        return "外部中继 · 运行中" + port;
      }
      const detail = typeof snap.detail === "string" ? snap.detail : "";
      if (detail) return detail;
      return "由外部管理";
    }

    async function apply(ctx) {
      try {
        await applyInner(ctx);
      } catch (e) {
        // eslint-disable-next-line no-console
        (typeof console !== "undefined" && console.error ? console.error : () => {})(
          "[dsh-remote-control] client apply failed; plugin disabled for this session:",
          e,
        );
      }
    }

    async function applyInner(ctx) {
      // Mount the remoteControl namespace before anything touches it; the
      // mount's lifetime is bound to this plugin's context by $mount itself. A
      // mount failure downgrades the page to an error state instead of
      // failing the whole bundle.
      let remote = null;
      try {
        await ctx.remote.$mount(CLIENT_REMOTE);
        remote = ctx.get("remote.remoteControl") || null;
      } catch (e) {
        // eslint-disable-next-line no-console
        (typeof console !== "undefined" && console.warn ? console.warn : () => {})(
          "[dsh-remote-control] remote.$mount failed; the settings page will show an error state:",
          e,
        );
      }

      let styleTag = null;
      try {
        styleTag = document.createElement("style");
        styleTag.textContent = CSS.replace(/__ICON_MASK__/g, CLIENT_ICON_MASK_URI);
        // dsh 0.2.0 client-modules runs `claimStyles(ownerId)` during
        // materialization, which claims every *untagged* <style> in the
        // document for the materializing package. `apply()` is async and appends
        // this tag after that sweep, so without an explicit owner it would stay
        // untagged and a later package could adopt it — and
        // `removeOwnedStyles(thatId)` would then strip our stylesheet on its
        // HMR invalidation. Claim it now.
        styleTag.setAttribute("data-plugin", CLIENT_BUNDLE_ID);
        document.head.appendChild(styleTag);
        ctx.effect(() => () => styleTag && styleTag.remove());
      } catch (e) {
        /* cosmetic only */
      }

      // Mark our settings-nav row so the CSS above replaces the shell's
      // fallback gear (no icon field exists in settings.section yet).
      try {
        ctx.effect(() => registerSettingsNavIcon(SETTINGS_LABEL));
      } catch (e) {
        /* cosmetic only */
      }

      function PairingPage() {
        const [state, setState] = React.useState({ loading: true, value: null, error: "", hint: "", hintKind: "" });
        const [busy, setBusy] = React.useState(false);
        const [saving, setSaving] = React.useState(false);
        // 中继地址输入框的草稿：null = 跟随宿主返回的值（没在编辑）
        const [relayDraft, setRelayDraft] = React.useState(null);
        // 宿主最近一次返回的中继地址：用来判断「宿主值真的变了」还是「只是轮询刷新」
        const lastHostUrl = React.useRef(null);

        const load = React.useCallback(async function () {
          if (!remote) {
            setState({ loading: false, value: null, error: "宿主 Remote 未就绪（remoteControl 未挂载）。", hint: "", hintKind: "" });
            return;
          }
          try {
            const res = unwrapRemote(await remote.getPairing());
            if (!res.ok) {
              setState({ loading: false, value: null, error: res.message, hint: "", hintKind: "" });
              return;
            }
            const nextUrl = String((res.value && res.value.relayUrl) || "");
            const hostChanged = lastHostUrl.current !== null && lastHostUrl.current !== nextUrl;
            lastHostUrl.current = nextUrl;
            // 宿主地址**真的变了**（保存成功/宿主侧改动）才让输入框回到跟随状态；
            // 轮询刷新时地址没变 → 保留用户正在编辑的草稿。
            if (hostChanged) setRelayDraft(null);
            setState((s) => ({
              loading: false,
              value: res.value,
              error: "",
              // 轮询刷新**不要**覆盖用户的提示文案（保存后的绿色提示会被冲掉）
              hint: hostChanged || s.hint === "" ? res.value.note || "" : s.hint,
              hintKind: hostChanged || s.hint === "" ? "ok" : s.hintKind,
            }));
          } catch (e) {
            setState((s) => ({
              loading: false,
              // 轮询失败不清空已有内容（可能是瞬时断连）
              value: s.value || null,
              error: s.value ? "" : String((e && e.message) || e),
              hint: s.hint,
              hintKind: s.hintKind,
            }));
          }
        }, [remote]);

        React.useEffect(() => {
          load();
        }, [load]);

        // 轻量轮询：让「中继进程」状态保持实时（托管的中继崩了/被换掉时能看出来），
        // 15s 一次，页面不可见时不做无用功。
        React.useEffect(() => {
          let timer = null;
          const tick = () => {
            if (typeof document !== "undefined" && document.hidden) return;
            void load();
          };
          timer = setInterval(tick, 15_000);
          return () => {
            if (timer) clearInterval(timer);
          };
        }, [load]);

        // 配对状态刷新后，输入框回到「跟随宿主值」——但**只在宿主地址真的变了**时
        // （轮询刷新不能把用户正在编辑的草稿冲掉）；判断已在上面的 load() 里完成。

        // 保存中继地址：成功 → 刷新整页配对状态 + 绿色提示；失败 → 红色提示（宿主原文）
        const saveRelay = React.useCallback(
          async function (draft) {
            if (!remote) return;
            setSaving(true);
            let note = "";
            try {
              const res = unwrapRemote(await remote.setRelayUrl(draft));
              if (!res.ok) {
                setState((s) => ({ ...s, hint: res.message, hintKind: "error" }));
                return;
              }
              note = String(res.value?.note || "");
              // 用新值先更新界面，再整页刷新（二维码/频道以宿主为准）
              setState({
                loading: false,
                value: res.value,
                error: "",
                hint: "中继地址已更新" + (note ? "：" + note : ""),
                hintKind: /回环|loopback/i.test(note) ? "error" : "ok",
              });
              await load();
              setState((s) => ({
                ...s,
                hint: "中继地址已更新" + (note ? "：" + note : ""),
                hintKind: /回环|loopback/i.test(note) ? "error" : "ok",
              }));
            } catch (e) {
              setState((s) => ({ ...s, hint: String((e && e.message) || e), hintKind: "error" }));
            } finally {
              setSaving(false);
            }
          },
          [remote, load],
        );

        const run = React.useCallback(
          async function (fn, okHint) {
            if (!remote) return;
            setBusy(true);
            try {
              const res = unwrapRemote(await fn());
              if (!res.ok) {
                setState((s) => ({ ...s, hint: res.message, hintKind: "error" }));
                return;
              }
              setState({
                loading: false,
                value: res.value,
                error: "",
                hint: res.value.note || okHint,
                hintKind: "ok",
              });
            } catch (e) {
              setState((s) => ({ ...s, hint: String((e && e.message) || e), hintKind: "error" }));
            } finally {
              setBusy(false);
            }
          },
          [remote],
        );

        if (state.loading) {
          return React.createElement(
            "div",
            { className: "rc-page" },
            React.createElement(
              "div",
              { className: "rc-loading" },
              React.createElement("span", { className: "rc-spinner" }),
              React.createElement("span", null, "正在读取配对信息…"),
            ),          );
        }

        const value = state.value || {};
        const hidden = value.hidden === true;
        const relayUrl = value.relayUrl || "";
        const channel = value.channel || "";
        const qrSvg = value.qrSvg || "";
        const relayInput = relayDraft === null ? relayUrl : relayDraft;
        return React.createElement(
          "div",
          { className: "rc-page" },
          // 头部：中继地址 + 连接状态
          React.createElement(
            "div",
            { className: "rc-head" },
            React.createElement("h2", { className: "rc-head-title" }, "DSH Pocket"),
            React.createElement(
              "span",
              { className: "rc-status" },
              React.createElement("span", {
                className: "rc-dot " + (relayUrl ? "rc-dot-online" : "rc-dot-offline"),
              }),
              relayUrl ? "已配置中继" : "未配置中继",
            ),
          ),
          state.error
            ? React.createElement("div", { className: "rc-hint rc-hint-error" }, state.error)
            : null,
          // 配对信息
          React.createElement(
            "div",
            { className: "rc-card" },
            React.createElement("h3", { className: "rc-card-title" }, "配对信息"),
            // 中继地址：可直接编辑保存（v1.1.x：不再要求用户改配置文件）
            React.createElement(
              "div",
              { className: "rc-field" },
              React.createElement("span", { className: "rc-label" }, "中继地址"),
              React.createElement(
                "div",
                { className: "rc-row" },
                React.createElement("input", {
                  type: "text",
                  className: "rc-input",
                  value: relayInput,
                  placeholder: "ws://192.168.x.x:8788",
                  spellCheck: false,
                  autoComplete: "off",
                  onChange: (e) => setRelayDraft(e && e.target ? e.target.value : ""),
                }),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "rc-btn",
                    disabled: saving || busy,
                    onClick: () => saveRelay(relayInput),
                  },
                  saving ? "保存中…" : "保存",
                ),
              ),
              React.createElement(
                "span",
                { className: "rc-note" },
                "留空即取消中继配置（插件停止连接）。手机需能访问该地址，填 localhost 手机连不上。",
              ),
            ),
            React.createElement(
              "div",
              { className: "rc-row" },
              React.createElement(
                "div",
                { className: "rc-field" },
                React.createElement("span", { className: "rc-label" }, "配对频道"),
                React.createElement("span", { className: "rc-value" }, channel || "（无）"),
              ),
            ),
            // v1.1.1：中继进程托管状态（让用户知道中继是谁在管、是否在跑）
            React.createElement(
              "div",
              { className: "rc-row" },
              React.createElement(
                "div",
                { className: "rc-field" },
                React.createElement("span", { className: "rc-label" }, "中继进程"),
                React.createElement(
                  "span",
                  { className: "rc-value" },
                  relayProcessText(value.relayProcess),
                ),
              ),
            ),
          ),
          // 二维码卡片
          React.createElement(
            "div",
            { className: "rc-card" },
            React.createElement("h3", { className: "rc-card-title" }, "手机配对二维码"),
            hidden
              ? React.createElement(
                  "div",
                  { className: "rc-qr-empty" },
                  "配对已隐藏：手机端请使用此前扫码保存的配对信息。",
                )
              : qrSvg
                ? React.createElement("div", {
                    className: "rc-qr",
                    dangerouslySetInnerHTML: { __html: qrSvg },
                  })
                : React.createElement("div", { className: "rc-qr-empty" }, "填写中继地址并保存后，这里会显示手机配对二维码。"),
            React.createElement(
              "p",
              { className: "rc-note" },
              "二维码内含配对凭据，请勿截图分享；轮换密钥后旧码立即失效。",
            ),
            // 操作
            React.createElement(
              "div",
              { className: "rc-actions" },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "rc-btn rc-btn-primary",
                  disabled: busy,
                  onClick: () => run(() => remote.rotateSecret(), "密钥已轮换，旧二维码立即失效。"),
                },
                "轮换密钥",
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "rc-btn",
                  disabled: busy,
                  onClick: () => run(() => remote.setHidden(!hidden), hidden ? "配对二维码已恢复显示。" : "配对二维码已隐藏。"),
                },
                hidden ? "显示配对" : "隐藏配对",
              ),
            ),
            state.hint
              ? React.createElement(
                  "div",
                  { className: "rc-hint" + (state.hintKind === "error" ? " rc-hint-error" : state.hintKind === "ok" ? " rc-hint-ok" : "") },
                  state.hint,
                )
              : null,
          ),
        );
      }

      // Settings entry: a full page under the sidebar Settings panel.
      try {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: "remote-control", order: 40, label: () => SETTINGS_LABEL },
            PairingPage,
          ),
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        (typeof console !== "undefined" && console.warn ? console.warn : () => {})(
          "[dsh-remote-control] settings.section registration failed:",
          e,
        );
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});
})();
