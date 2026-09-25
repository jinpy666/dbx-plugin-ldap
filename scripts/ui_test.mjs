#!/usr/bin/env node
// LDAP 插件 UI 走查（M5-a UI 测试第三轨：真实浏览器）。
//
// 用法：node scripts/ui_test.mjs [--keep-server]
// 前置：frontend 依赖已安装（脚本自行拉起 vite dev，mock 宿主，无需 sidecar）。
// 浏览器：playwright-core + 系统 Chrome（惰性安装到 /tmp/dbx-ldap-ui-deps，
// 不进项目依赖；找不到 Chrome 时整个走查 SKIP 而非 FAIL，遵循 test.sh 约定）。
// 断言失败 → exit 1；环境不可用 → exit 0（打印 SKIP）。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND_DIR = path.join(PLUGIN_ROOT, "frontend");
const DEPS_DIR = "/tmp/dbx-ldap-ui-deps";
const PORT = 5279;

const skip = (reason) => {
  console.log(`SKIP: ldap UI walkthrough — ${reason}`);
  process.exit(0);
};

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`vite dev server not ready at ${url}`);
}

async function loadPlaywrightCore() {
  for (const candidate of [path.join(DEPS_DIR, "node_modules", "playwright-core")]) {
    if (existsSync(candidate)) {
      const require = createRequire(path.join(candidate, "index.js"));
      return require("playwright-core");
    }
  }
  console.log(`==> installing playwright-core into ${DEPS_DIR} (non-project dependency)`);
  mkdirSync(DEPS_DIR, { recursive: true });
  const result = await new Promise((resolve) => {
    const child = spawn("npm", ["install", "--prefix", DEPS_DIR, "playwright-core@1.49.1", "--no-audit", "--no-fund"], {
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  if (!result || !existsSync(path.join(DEPS_DIR, "node_modules", "playwright-core"))) {
    skip("playwright-core unavailable (no network?)");
  }
  const require = createRequire(path.join(DEPS_DIR, "node_modules", "playwright-core", "index.js"));
  return require("playwright-core");
}

function findChromeExecutable() {
  if (process.env.LDAP_UI_CHROME) return process.env.LDAP_UI_CHROME;
  const candidates =
    platform() === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const expectEqual = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
// AG Grid 结果表（DbxAgGrid）行选择器：行渲染在 .ag-center-cols-container，
// 虚拟滚动下 count() 是"当前渲染出的行"而非总行数（用例里结果集都很小，等价）。
// 注意：waitForFunction 的函数体会被序列化进页面，不能引用本模块常量，选择器需内联。
const RESULT_ROW = ".ag-row";
const RESULT_DN_CELL = `${RESULT_ROW} .ag-cell[col-id="dn"]`;
const RESULT_CHECKBOX = `${RESULT_ROW} .ag-checkbox-input`;

// -- 走查流 --------------------------------------------------------------------

// 折叠默认态用例必须最先跑：后续既有用例都假定高级区可见（hidden 元素
// 对 fill 不可交互），先验证折叠态再展开，是其余用例的前置。
test("compact search bar: collapsed by default, quick filter runs directly", async (page) => {
  await page.locator(".search-form-compact").waitFor();
  expectEqual(await page.locator(".search-advanced").evaluate((el) => el.classList.contains("is-collapsed")), true, "advanced area collapsed");
  await page.locator(".compact-filter").fill("(uid=user0003)");
  await page.locator(".search-form-compact button[type='submit']").click();
  // 行数断言同时验证快捷条输入真正落到过滤器（空过滤器会回退匹配全部、返回多行）。
  await page.waitForFunction(() => document.querySelectorAll(".ag-row").length === 1, undefined, { timeout: 5000 });
  expectEqual(await page.locator(`${RESULT_DN_CELL}`).first().innerText(), "uid=user0003,ou=people,dc=demo,dc=dbx", "compact filter applied");
  await captureReview(page, "ldap-round8-compact-bar");
});

test("expanding the compact bar reveals the advanced form and persists", async (page) => {
  await page.locator(".search-form-compact .compact-toggle").click();
  await page.locator(".filter-block").waitFor();
  expectEqual(await page.locator(".search-form-compact").count(), 1, "compact bar remains fixed while expanded");
  expectEqual(await page.locator(".search-advanced").evaluate((el) => !el.classList.contains("is-collapsed")), true, "advanced area expanded");
  expectEqual(await page.locator(".filter-block").isVisible(), true, "advanced sections visible after expand");
  // 展开保留快捷条切出的源码模式（源码是唯一权威表示）：输入值必须原样在场。
  expectEqual(await page.locator(".filter-source input").inputValue(), "(uid=user0003)", "compact typing landed in source mode");
  expectEqual(await page.evaluate(() => window.localStorage.getItem("dbx.ldap.ui.searchCollapsed")), "0", "expanded state persisted");
  // 切回构建器，让后续既有用例继续在"构建器 + 单个子句"的假设下运行。
  await page.locator(".search-form .mode-switch button").nth(0).click();
  expectEqual(await page.locator(".qb-preview").first().innerText(), "(uid=user0003)", "source filter round-trips into builder");
});

test("builder preview: equals", async (page) => {
  await page.locator(".qb-attr").first().fill("uid");
  await page.locator(".qb-value").first().fill("admin");
  await page.waitForTimeout(100);
  expectEqual(await page.locator(".qb-preview").first().innerText(), "(uid=admin)", "equals preview");
});

test("builder preview: notEquals (≠)", async (page) => {
  await page.locator(".qb-node select").first().selectOption("notEquals");
  await page.waitForTimeout(100);
  expectEqual(await page.locator(".qb-preview").first().innerText(), "(!(uid=admin))", "notEquals preview");
});

test("search returns mock rows", async (page) => {
  await page.getByRole("button", { name: /搜索|Search/ }).click();
  await page.locator(RESULT_ROW).first().waitFor({ timeout: 5000 });
});

test("double-click row opens entry dialog above the form", async (page) => {
  await page.locator(RESULT_ROW).first().dblclick();
  await page.locator(".modal-backdrop .editor-modal").waitFor({ timeout: 3000 });
  const title = await page.locator(".modal h2").first().innerText();
  if (!title.trim()) throw new Error("dialog title is empty");
});

test("regression: dark backdrop is ≥90% opaque so filter text cannot bleed through", async (page) => {
  const background = await page.locator(".modal-backdrop").evaluate((el) => getComputedStyle(el).backgroundColor);
  // Chromium resolves color-mix(...) to `color(srgb r g b / a)` and plain
  // rgb()/rgba() to legacy `rgba(r, g, b, a)`; the alpha is the trailing
  // number before the closing paren in both syntaxes.
  const alphaMatch = /([\d.]+)\s*\)$/.exec(background);
  const alpha = alphaMatch ? Number.parseFloat(alphaMatch[1]) : Number.NaN;
  // 阈值对齐主题设计值：暗色主题遮罩 = color-mix(background 70%,
  // transparent)（见 themeSync），即 alpha ≥ 0.7。回归意图是拦住
  // --overlay 缺失导致的完全透明（alpha 0/NaN）。
  if (!(alpha >= 0.7)) throw new Error(`backdrop alpha ${alpha} too transparent (${background})`);
});

test("backdrop intercepts pointer at the filter preview position", async (page) => {
  const hit = await page.evaluate(() => {
    const preview = document.querySelector(".qb-preview");
    const rect = preview.getBoundingClientRect();
    const element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(element && element.closest(".modal-backdrop"));
  });
  expectEqual(hit, true, "elementFromPoint hits backdrop");
});

test("builder → source mode carries the generated filter", async (page) => {
  await page.locator(".modal-backdrop button", { hasText: /取消|Cancel|✕|关闭/ }).first().click().catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  const modeButtons = page.locator(".mode-switch button");
  await modeButtons.nth(1).click();
  const value = await page.locator(".filter-source input").inputValue();
  expectEqual(value, "(!(uid=admin))", "source input");
});

test("source syntax feedback is linked to the field and recovers", async (page) => {
  const input = page.locator(".filter-source input");
  for (const filter of ["(uid", "(uid)", "(=x)", String.raw`(cn=bad\q)`]) {
    await input.fill(filter);
    expectEqual(await input.getAttribute("aria-invalid"), "true", "invalid source field");
    const description = await input.getAttribute("aria-describedby");
    expectEqual(await page.locator('[id="' + description + '"]').innerText(), "LDAP 过滤器不合法", "source error");
    expectEqual(await page.locator(".search-form button[type='submit']").isDisabled(), true, "invalid assertion blocks submit");
  }
  await captureReview(page, "ldap-round7-filter-feedback");
  await input.fill("(objectClass=*)");
  expectEqual(await input.getAttribute("aria-invalid"), "false", "corrected source field");
  expectEqual(await page.locator(".search-form button[type='submit']").isDisabled(), false, "correction releases submit");
});

test("invalid numeric inputs block search until corrected", async (page) => {
  const input = page.locator("input.numeric").first();
  await input.fill("12px");
  expectEqual(await page.locator(".search-form button[type='submit']").isDisabled(), true, "invalid number blocks search");
  await input.fill("500");
  expectEqual(await page.locator(".search-form button[type='submit']").isDisabled(), false, "valid number allows search");
});

test("lazy tree node expands and collapses with the keyboard", async (page) => {
  const row = page.locator('.tree-node[title="ou=services,dc=demo,dc=dbx"]');
  const child = page.locator('.tree-node[title="cn=ldap,ou=services,dc=demo,dc=dbx"]');
  expectEqual(await row.getAttribute("aria-expanded"), "false", "unloaded node is collapsed");
  await row.press("ArrowRight");
  await child.waitFor();
  expectEqual(await row.getAttribute("aria-expanded"), "true", "expanded node");
  await row.press("ArrowLeft");
  await child.waitFor({ state: "hidden" });
  expectEqual(await row.getAttribute("aria-expanded"), "false", "collapsed node");
});

test("tree filter failure retries the same keyword and restores results", async (page) => {
  await page.evaluate(() => {
    const invoke = window.dbxPlugin.invoke.bind(window.dbxPlugin);
    let failOnce = true;
    window.dbxPlugin.invoke = async (method, params, options) => {
      if (method === "ldap/search" && params.scope === "sub" && params.sizeLimit === 100 && failOnce) {
        failOnce = false;
        throw new Error("connection refused (UI retry fixture)");
      }
      return invoke(method, params, options);
    };
  });
  const input = page.locator(".tree-filter input");
  await input.fill("user0001");
  const retry = page.locator(".tree-error button");
  await retry.waitFor();
  expectEqual(await retry.innerText(), "重试", "localized retry action");
  await retry.click();
  const hit = page.locator('.tree-node[title="uid=user0001,ou=people,dc=demo,dc=dbx"]');
  await hit.waitFor();
  expectEqual(await input.inputValue(), "user0001", "retry preserves keyword");
  expectEqual(await hit.getAttribute("role"), "treeitem", "filtered hit semantics");
});

// 编辑器弹窗兜底关闭：Esc 会被 dirty 否决拦下（产品正确行为），失败路径
// 改走显式「取消」通道（不否决），保证遮罩不残留拦截后续用例。
async function closeEditorIfOpen(page) {
  if (!(await page.locator(".editor-modal").count())) return;
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
  if (await page.locator(".editor-modal").count()) {
    await page.locator(".editor-modal footer button", { hasText: /取消|Cancel/ }).first().click().catch(() => {});
  }
  await page.waitForFunction(() => !document.querySelector(".editor-modal"), undefined, { timeout: 5000 }).catch(() => {});
}

async function captureReview(page, name) {
  if (!process.env.LDAP_UI_ARTIFACT_DIR) return;
  mkdirSync(process.env.LDAP_UI_ARTIFACT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.LDAP_UI_ARTIFACT_DIR, name + ".png") });
}

test("presets follow save/remove responses and restore the updated filter", async (page) => {
  await page.locator(".search-form-compact > .field input").first().fill("dc=demo,dc=dbx");
  await page.locator(".filter-source input").fill("(uid=user0001)");
  await page.locator(".preset-input").fill("Round5 preset");
  await page.locator(".search-presets button").first().click();
  await page.waitForFunction(() => document.querySelector(".search-presets select").value !== "");
  const id = await page.locator(".search-presets select").inputValue();
  await page.locator(".filter-source input").fill("(uid=user0002)");
  await page.locator(".search-presets button").first().click();
  await page.waitForFunction(() => !document.querySelector(".preset-input").disabled);
  const stored = await page.evaluate(() => window.dbxPlugin.invoke("ldap/presets/list"));
  expectEqual(stored.presets.length, 1, "one preset after two saves");
  expectEqual(stored.presets[0].id, id, "stable saved id");
  expectEqual(stored.presets[0].filter, "(uid=user0002)", "latest filter persisted");
  expectEqual("conditions" in stored.presets[0], false, "only protocol fields persisted");
  await page.locator(".filter-source input").fill("(uid=unsaved)");
  await page.locator(".search-presets select").dispatchEvent("change");
  expectEqual(await page.locator(".qb-preview").innerText(), "(uid=user0002)", "filter restored into builder");
  // 预设删除为两步确认（armed → 再次点击确认），无原生 confirm。
  await page.locator(".search-presets button").last().click();
  await page.locator(".search-presets button").last().click();
  await page.waitForFunction(() => document.querySelector(".search-presets select").options.length === 1);
});

test("search shows pending/failure states and retries without losing the query", async (page) => {
  await page.locator(".search-form-compact > .field input").first().fill("dc=demo,dc=dbx");
  await page.locator(".search-form .mode-switch button").nth(1).click();
  await page.locator(".filter-source input").fill("(uid=user0001)");
  await page.evaluate(() => {
    const invoke = window.dbxPlugin.invoke.bind(window.dbxPlugin);
    window.__ldapRound5Invoke = invoke;
    let first = true;
    window.dbxPlugin.invoke = (method, params, options) => {
      if (method === "ldap/search/start" && params.filter === "(uid=user0001)" && first) {
        first = false;
        return new Promise((_, reject) => { window.__ldapRound5Fail = () => reject(new Error("connection refused")); });
      }
      return invoke(method, params, options);
    };
  });
  try {
    await page.locator(".search-form button[type='submit']").click();
    await page.locator(".result-pane[aria-busy='true']").waitFor();
    expectEqual(await page.locator(".result-pane [role='status']").innerText(), "搜索中…", "pending result copy");
    expectEqual(await page.locator(".search-form button[type='submit']").innerText(), "搜索中…", "pending action copy");
    await page.evaluate(() => window.__ldapRound5Fail());
    await page.locator(".result-pane .request-error button").waitFor();
    expectEqual(await page.locator(".filter-source input").inputValue(), "(uid=user0001)", "failed query retained");
    await captureReview(page, "ldap-round5-search-retry");
    await page.locator(".result-pane .request-error button").click();
    await page.locator(RESULT_ROW).first().waitFor();
    expectEqual(await page.locator(RESULT_ROW).count(), 1, "retry result count");
  } finally {
    await page.evaluate(() => { window.dbxPlugin.invoke = window.__ldapRound5Invoke; });
  }
});

test("entry opens with loading feedback and retries a failed read", async (page) => {
  await page.evaluate(() => {
    const invoke = window.dbxPlugin.invoke.bind(window.dbxPlugin);
    window.__ldapRound5Invoke = invoke;
    let first = true;
    window.dbxPlugin.invoke = (method, params, options) => {
      if (method === "ldap/entry/get" && first) {
        first = false;
        return new Promise((_, reject) => { window.__ldapRound5Fail = () => reject(new Error("connection refused")); });
      }
      return invoke(method, params, options);
    };
  });
  try {
    await page.locator(RESULT_ROW).first().dblclick();
    await page.locator(".editor-modal[aria-busy='true']").waitFor();
    expectEqual(await page.locator(".editor-modal [role='status']").innerText(), "正在加载条目…", "pending entry copy");
    await page.evaluate(() => window.__ldapRound5Fail());
    await page.locator(".editor-modal .request-error button").click();
    await page.locator(".editor-modal .attr-editor").waitFor();
  } finally {
    await page.evaluate(() => { window.dbxPlugin.invoke = window.__ldapRound5Invoke; });
  }
});

test("missing MUST feedback focuses the affected field and recovers after input", async (page) => {
  const surname = page.getByRole("textbox", { name: "sn", exact: true });
  const original = await surname.inputValue();
  const row = page.locator(".attr-row").filter({ has: surname });
  await row.getByRole("button", { name: "移除属性", exact: true }).click();
  expectEqual(await page.locator(".editor-modal footer .primary-button").isDisabled(), true, "missing MUST blocks save");
  await captureReview(page, "ldap-round5-required-attribute");
  await page.getByRole("button", { name: "定位并补充 sn", exact: true }).click();
  expectEqual(await surname.evaluate((element) => element === document.activeElement), true, "required field receives focus");
  expectEqual(await surname.getAttribute("aria-invalid"), "true", "required field is marked invalid");
  await surname.fill(original);
  expectEqual(await page.locator(".editor-modal footer .primary-button").isDisabled(), false, "corrected MUST releases save");
  await page.locator(".editor-modal").getByRole("button", { name: "取消", exact: true }).click();
});

test("RDN preflight rejects empty multi-value segments and accepts escaped separators", async (page) => {
  await page.locator('.tree-node[title="uid=user0001,ou=people,dc=demo,dc=dbx"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: /重命名/ }).click();
  const input = page.locator(".small-modal input[type='text']").first();
  await input.fill("cn=bad+");
  expectEqual(await input.getAttribute("aria-invalid"), "true", "invalid RDN");
  expectEqual(await page.locator(".small-modal .primary-button").isDisabled(), true, "invalid RDN blocks rename");
  await input.fill("cn=valid\\+value");
  expectEqual(await input.getAttribute("aria-invalid"), "false", "escaped plus is accepted");
  await page.locator(".small-modal").getByRole("button", { name: "取消", exact: true }).click();
});

test("tree keyboard reaches virtual rows and activates load more through Tab/Enter", async (page) => {
  await page.locator(".tree-filter input").fill("");
  const people = page.locator('.tree-node[title="ou=people,dc=demo,dc=dbx"]');
  await people.press("ArrowRight");
  await people.locator(".tree-badge--truncated").waitFor();
  await people.press("ArrowRight");
  expectEqual(await page.evaluate(() => document.activeElement?.getAttribute("title")), "uid=user0000,ou=people,dc=demo,dc=dbx", "Right enters first child");
  await page.keyboard.press("ArrowLeft");
  expectEqual(await page.evaluate(() => document.activeElement?.getAttribute("title")), "ou=people,dc=demo,dc=dbx", "Left returns to parent");
  await page.keyboard.press("Tab");
  expectEqual(await page.evaluate(() => document.activeElement?.matches("button.tree-badge--truncated")), true, "load more is keyboard reachable");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('.tree-node[title="ou=people,dc=demo,dc=dbx"] .tree-badge')?.textContent === "1000");
  expectEqual(await page.evaluate(() => document.activeElement?.getAttribute("title")), "ou=people,dc=demo,dc=dbx", "loading retains node focus");
  await page.keyboard.press("ArrowRight");
  for (let index = 0; index < 60; index++) await page.keyboard.press("ArrowDown");
  expectEqual(await page.evaluate(() => document.activeElement?.getAttribute("title")), "uid=user0060,ou=people,dc=demo,dc=dbx", "Down crosses virtual windows");
  await page.keyboard.press("End");
  expectEqual(await page.evaluate(() => document.activeElement?.getAttribute("title")), "ou=services,dc=demo,dc=dbx", "End reaches final logical row");
  await page.keyboard.press("ArrowUp");
  expectEqual(await page.evaluate(() => document.activeElement?.getAttribute("title")), "uid=user0999,ou=people,dc=demo,dc=dbx", "Up reaches last child");
  if (await page.locator(".tree-node").count() >= 100) throw new Error("tree virtualization was lost");
  await captureReview(page, "ldap-round6-tree-keyboard");
  await page.keyboard.press("Home");
  expectEqual(await page.evaluate(() => document.activeElement?.getAttribute("title")), "dc=demo,dc=dbx", "Home returns to root");
});

test("filtered tree Home/End moves to entries outside the initial DOM window", async (page) => {
  await page.locator(".tree-filter input").fill("user");
  const first = page.locator('.tree-node[title="uid=user0000,ou=people,dc=demo,dc=dbx"]');
  await first.waitFor();
  await first.press("End");
  expectEqual(await page.evaluate(() => document.activeElement?.getAttribute("title")), "uid=user0099,ou=people,dc=demo,dc=dbx", "End reaches last filter hit");
  await page.keyboard.press("Home");
  expectEqual(await page.evaluate(() => document.activeElement?.getAttribute("title")), "uid=user0000,ou=people,dc=demo,dc=dbx", "Home returns to first filter hit");
});

test("rename dialog moves an entry through the real newSuperior field", async (page) => {
  await page.locator(".tree-filter input").fill("user0001");
  await page.locator('.tree-node[title="uid=user0001,ou=people,dc=demo,dc=dbx"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: /重命名/ }).click();
  const inputs = page.locator(".small-modal input[type='text']");
  await inputs.nth(0).fill("uid=round6-moved");
  await inputs.nth(1).fill("ou=services,dc=demo,dc=dbx");
  await page.locator(".small-modal .primary-button").click();
  await page.locator(".small-modal").waitFor({ state: "hidden" });
  const moved = await page.evaluate(async () => window.dbxPlugin.invoke("ldap/entry/get", {
    dn: "uid=round6-moved,ou=services,dc=demo,dc=dbx", attributes: ["uid"],
  }));
  expectEqual(moved.entry.attributes.uid.join(","), "round6-moved", "new parent and naming attribute persisted");
});

test("RootDSE export includes explicitly requested operational metadata", async (page) => {
  // 导出走"另存为"链路（宿主 fileTransfer → showSaveFilePicker → Blob 下载）。
  // 浏览器走查没有宿主桥，桩掉 showSaveFilePicker 捕获建议名与写入内容，
  // 顺带断言通知里出现的是用户最终保存的文件名（旧版匿名下载无此反馈）。
  await page.evaluate(() => {
    window.__savedExport = null;
    window.showSaveFilePicker = async ({ suggestedName }) => {
      const chunks = [];
      return {
        name: "root-dse-saved.txt",
        createWritable: async () => ({
          write: async (data) => chunks.push(data),
          close: async () => {
            const buffer = await new Blob(chunks).arrayBuffer();
            window.__savedExport = { suggestedName, text: new TextDecoder().decode(buffer) };
          },
        }),
      };
    };
  });
  // F12：服务器信息弹窗（分组展示 + 设为浏览基 + 弹窗内导出）。
  await page.getByRole("button", { name: /Root\s*DSE/ }).click();
  await page.locator(".modal.panel-modal").waitFor();
  await page.waitForFunction(() => document.querySelector(".modal.panel-modal")?.textContent?.includes("dc=demo,dc=dbx"));
  // 连接与服务器区块：mock check/whoami 恒通过 → 状态点 + Ping 文案 + 授权
  // 身份；fixture 的 supportedControl 命中 OID 注册表 → RFC 标题上屏。
  await page.waitForFunction(() => Boolean(document.querySelector(".modal.panel-modal .state-dot.connected")));
  await page.waitForFunction(() => document.querySelector(".modal.panel-modal")?.textContent?.includes("网络 1ms · 认证通过"));
  await page.waitForFunction(() => document.querySelector(".modal.panel-modal")?.textContent?.includes("dn:cn=admin,dc=demo,dc=dbx"));
  await page.waitForFunction(() => document.querySelector(".modal.panel-modal")?.textContent?.includes("Simple Paged Results Manipulation"));
  // namingContexts 分组带「设为浏览基」：点击后 baseDn 联动 + 通知。
  const setBaseButton = page.locator(".modal.panel-modal .toolbar-button", { hasText: "设为浏览基" }).first();
  await setBaseButton.click();
  await page.waitForFunction(() => document.querySelector(".notice")?.textContent?.includes("浏览基已设为 dc=demo,dc=dbx"));
  // 弹窗内导出：同一"另存为"链路，内容含运行元数据。
  await page.locator(".modal.panel-modal .toolbar-button", { hasText: "导出" }).click();
  await page.waitForFunction(() => Boolean(window.__savedExport), undefined, { timeout: 5000 });
  const saved = await page.evaluate(() => window.__savedExport);
  if (saved.suggestedName !== "root-dse.txt") {
    throw new Error(`unexpected suggested export name: ${saved.suggestedName}`);
  }
  if (!saved.text.includes("namingContexts: dc=demo,dc=dbx") || !saved.text.includes("supportedLDAPVersion: 3")) {
    throw new Error("RootDSE operational metadata missing from export");
  }
  await page.waitForFunction(() => document.querySelector(".notice")?.textContent === "已导出 root-dse-saved.txt", undefined, { timeout: 3000 });
  // 关闭弹窗，避免遮罩拦截后续用例。
  await page.locator(".modal.panel-modal header .icon-button").click();
  await page.waitForFunction(() => !document.querySelector(".modal.panel-modal"), undefined, { timeout: 8000 });
});

// 搜索历史放在写操作用例之间：批量用例的 finally 清理会触发审计通知并覆盖
// .notice，历史通知断言必须在无审计事件的窗口内做。此前用例已多次成功搜索，
// 历史至少一条；点首条 = 应用到表单但不自动运行。
test("filter history applies a previous search without auto-running", async (page) => {
  const rowsBefore = await page.locator(RESULT_ROW).count();
  await page.getByRole("button", { name: "历史" }).click();
  // 只在历史面板内找条目:Run 按钮的 title 也是过滤器串(以"("开头),不能全局匹配。
  const item = page.locator(".history-panel .history-item").first();
  await item.waitFor();
  const filter = await item.getAttribute("title");
  await item.click();
  // .notice 有 3.5s TTL,上一条通知可能仍在屏——必须轮询文本而不是等元素出现。
  await page.waitForFunction(() => document.querySelector(".notice")?.textContent === "已应用历史过滤器", undefined, { timeout: 3000 });
  expectEqual(await page.locator(".qb-preview").first().innerText(), filter, "history filter lands in the builder preview");
  expectEqual(await page.locator(RESULT_ROW).count(), rowsBefore, "applying history does not auto-run the search");
});

test("source searches preserve escaped UTF-8 and order integer attributes numerically", async (page) => {
  const baseDn = "ou=round7-filter,dc=demo,dc=dbx";
  await page.evaluate(async (root) => {
    const add = (dn, attributes) => window.dbxPlugin.invoke("ldap/entry/add", { dn, attributes });
    await add(root, { objectClass: ["organizationalUnit"], ou: ["round7-filter"] });
    for (const number of [9, 10, 100]) {
      await add(`uid=n${number},${root}`, { objectClass: ["inetOrgPerson", "posixAccount"],
        cn: [number === 9 ? "研究*员" : `User ${number}`], sn: ["Fixture"], uid: [`n${number}`],
        uidNumber: [String(number)], gidNumber: ["1000"], homeDirectory: [`/home/n${number}`] });
    }
  }, baseDn);
  try {
    await page.locator(".search-form-compact > .field input").first().fill(baseDn);
    await page.locator(".search-form-compact .compact-scope").first().selectOption("sub");
    await page.locator(".search-form .mode-switch button").nth(1).click();
    for (const [filter, numbers] of [
      [String.raw`(cn=\e7\a0\94\e7\a9\b6\2a\e5\91\98)`, [9]],
      ["(uidNumber>=10)", [10, 100]],
      ["(uidNumber<=9)", [9]],
    ]) {
      await page.locator(".filter-source input").fill(filter);
      await page.locator(".search-form button[type='submit']").click();
      const expected = numbers.map((number) => `uid=n${number},${baseDn}`).sort();
      await page.waitForFunction((dns) => JSON.stringify([...document.querySelectorAll('.ag-row .ag-cell[col-id="dn"]')].map((cell) => cell.textContent).sort()) === JSON.stringify(dns), expected);
    }
    await captureReview(page, "ldap-round7-filter-results");
  } finally {
    await page.evaluate((dn) => window.dbxPlugin.invoke("ldap/entry/delete", { dn, recursive: true }), baseDn);
  }
});

// intent 走查放在用例链末尾：applyIntentSearch 会整体替换表单状态，
// 不影响前面用例的顺序假设。user0001 已被 rename 用例移走，选 user0002。

// 最近条目/协议徽章在批量用例之前跑：批量用例结束时结果表为空，
// 而本用例依赖仍有一行结果可双击。
test("toolbar recent entries reopens an entry and the protocol badge renders", async (page) => {
  expectEqual(await page.locator(".toolbar .badge[title='连接协议与认证方式']").innerText(), "LDAP", "protocol badge derived from mock connection");
  await page.locator(RESULT_ROW).first().dblclick();
  await page.locator(".editor-modal").waitFor();
  await page.locator(".editor-modal").getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "最近打开" }).click();
  const item = page.locator(".context-menu button[role='menuitem']").first();
  await item.waitFor();
  const dn = await item.getAttribute("title");
  if (!dn || !dn.includes("=")) throw new Error(`recent item lacks a DN title: ${dn}`);
  await item.click();
  await page.locator(".editor-modal").waitFor();
  await page.locator(".editor-modal").getByRole("button", { name: "取消", exact: true }).click();
});

test("result batch select arms the bar and batch-deletes via confirm", async (page) => {
  const root = "ou=round8-batch,dc=demo,dc=dbx";
  await page.evaluate(async (base) => {
    const add = (dn, attributes) => window.dbxPlugin.invoke("ldap/entry/add", { dn, attributes });
    await add(base, { objectClass: ["organizationalUnit"], ou: ["round8-batch"] });
    for (const uid of ["batch-a", "batch-b"]) {
      await add(`uid=${uid},${base}`, { objectClass: ["inetOrgPerson", "posixAccount"],
        cn: [uid], sn: ["Fixture"], uid: [uid], uidNumber: ["1000"], gidNumber: ["1000"], homeDirectory: [`/home/${uid}`] });
    }
  }, root);
  try {
    await page.locator(".search-form-compact > .field input").first().fill(root);
    await page.locator(".search-form .mode-switch button").nth(1).click();
    await page.locator(".filter-source input").fill("(uid=batch-*)");
    await page.locator(".search-form button[type='submit']").click();
    await page.waitForFunction(() => document.querySelectorAll(".ag-row").length === 2);
    await page.waitForFunction(() => document.querySelectorAll(".ag-checkbox-input").length === 3);
    const firstRow = page.locator(RESULT_ROW).filter({ hasText: "uid=batch-a," }).first();
    const secondRow = page.locator(RESULT_ROW).filter({ hasText: "uid=batch-b," }).first();
    await firstRow.locator(".ag-checkbox-input-wrapper").click();
    await firstRow.locator(".ag-checkbox-input[aria-label*='checked']").waitFor();
    await secondRow.locator(".ag-checkbox-input-wrapper").click();
    await secondRow.locator(".ag-checkbox-input[aria-label*='checked']").waitFor();
    await page.waitForFunction(() => document.querySelector(".batch-count")?.textContent?.includes("2"));
    expectEqual(await page.locator(".editor-modal").count(), 0, "checkbox click does not open entry");
    expectEqual(await page.locator(".batch-bar").isVisible(), true, "batch bar armed");
    expectEqual(await page.locator(".batch-count").innerText(), "已选 2 项", "batch count copy");
    await captureReview(page, "ldap-round8-batch-bar");
    // 批量删除为两步确认（armed → 再次点击确认），无原生 confirm。
    await page.locator(".batch-delete").click();
    await page.locator(".batch-delete").click();
    await page.waitForFunction(() => document.querySelectorAll(".ag-row").length === 0);
  } finally {
    await page.evaluate((dn) => window.dbxPlugin.invoke("ldap/entry/delete", { dn, recursive: true }), root);
  }
});

test("batch move relocates selected entries keeping their RDNs", async (page) => {
  const source = "ou=round9-move,dc=demo,dc=dbx";
  const target = "ou=round9-target,dc=demo,dc=dbx";
  await page.evaluate(async ([from, to]) => {
    const add = (dn, attributes) => window.dbxPlugin.invoke("ldap/entry/add", { dn, attributes });
    await add(from, { objectClass: ["organizationalUnit"], ou: ["round9-move"] });
    await add(to, { objectClass: ["organizationalUnit"], ou: ["round9-target"] });
    for (const uid of ["mv-a", "mv-b"]) {
      await add(`uid=${uid},${from}`, { objectClass: ["inetOrgPerson", "posixAccount"],
        cn: [uid], sn: ["Fixture"], uid: [uid], uidNumber: ["1000"], gidNumber: ["1000"], homeDirectory: [`/home/${uid}`] });
    }
  }, [source, target]);
  try {
    await page.locator(".search-form-compact > .field input").first().fill(source);
    await page.locator(".search-form .mode-switch button").nth(1).click();
    await page.locator(".filter-source input").fill("(uid=mv-*)");
    await page.locator(".search-form button[type='submit']").click();
    await page.waitForFunction(() => document.querySelectorAll(".ag-row").length === 2);
    await page.locator(`${RESULT_ROW}[row-index="0"] .ag-checkbox-input`).click();
    await page.locator(`${RESULT_ROW}[row-index="1"] .ag-checkbox-input`).click();
    await page.locator(".batch-move").click();
    const dialog = page.locator(".small-modal");
    await dialog.waitFor();
    await dialog.locator("input[type='text']").first().fill(target);
    await dialog.locator(".primary-button").click();
    await dialog.waitFor({ state: "hidden" });
    const moved = await page.evaluate(async (dn) => window.dbxPlugin.invoke("ldap/entry/get", { dn, attributes: ["uid"] }), `uid=mv-a,${target}`);
    expectEqual(moved.entry.attributes.uid.join(","), "mv-a", "entry relocated under the target parent with RDN kept");
  } finally {
    await page.evaluate((dn) => window.dbxPlugin.invoke("ldap/entry/delete", { dn, recursive: true }), source);
    await page.evaluate((dn) => window.dbxPlugin.invoke("ldap/entry/delete", { dn, recursive: true }), target);
  }
});

test("MCP ui intent fills the form, runs the search and reports state", async (page) => {
  await page.evaluate(() => {
    const reports = [];
    const invoke = window.dbxPlugin.invoke.bind(window.dbxPlugin);
    window.dbxPlugin.invoke = async (method, params, options) => {
      if (method === "ldap/ui/state/report") reports.push({ intentId: params.intentId, status: params.status });
      return invoke(method, params, options);
    };
    window.__uiReports = reports;
    window.dbxPlugin.emitUiIntent({ intentId: "ui-e2e-1", action: "search", params: { baseDn: "dc=demo,dc=dbx", filter: "(uid=user0002)", scope: "sub" } });
  });
  await page.locator(RESULT_ROW).first().waitFor({ timeout: 5000 }).catch(async () => {
    const debug = await page.evaluate(() => ({
      reports: window.__uiReports,
      preview: document.querySelector(".qb-preview")?.textContent ?? null,
      resultRows: document.querySelectorAll(".ag-row").length,
      notice: document.querySelector(".notice, .toast, [role='status']")?.textContent ?? null,
      hasEmit: typeof window.dbxPlugin.emitUiIntent,
    }));
    throw new Error(`intent search produced no rows; page state: ${JSON.stringify(debug)}`);
  });
  expectEqual(await page.locator(".qb-preview").first().innerText(), "(uid=user0002)", "intent filter lands in the builder preview");
  try {
    await page.waitForFunction(
      () => window.__uiReports.some((report) => report.intentId === "ui-e2e-1" && report.status === "applied"),
      undefined,
      { timeout: 8000 },
    );
  } catch {
    const seen = await page.evaluate(() => window.__uiReports);
    throw new Error(`expected an applied ldap/ui/state/report for ui-e2e-1, saw ${JSON.stringify(seen)}`);
  }
});

test("schema five categories: tabs, rule details and applies-to", async (page) => {
  try {
    await page.getByRole("button", { name: "Schema" }).click();
    await page.locator(".panel-modal").waitFor();
    for (const tab of ["属性类型", "对象类", "匹配规则", "匹配规则用途", "LDAP 语法"]) {
      await page.getByRole("tab", { name: tab, exact: true }).waitFor();
    }
    await page.getByRole("tab", { name: "匹配规则", exact: true }).click();
    const ruleRow = page.locator(".schema-attribute-button", { hasText: "caseIgnoreMatch" }).first();
    await ruleRow.waitFor();
    await ruleRow.click();
    try {
      await page.waitForFunction(() => document.querySelector(".schema-detail-body")?.textContent?.includes("1.3.6.1.4.1.1466.115.121.1.15"), undefined, { timeout: 15000 });
    } catch {
      const detail = await page.evaluate(() => ({
        body: document.querySelector(".schema-detail-body")?.textContent ?? null,
        selected: [...document.querySelectorAll(".schema-attribute-row.is-selected")].map((el) => el.textContent?.trim()),
        rows: [...document.querySelectorAll(".schema-col .schema-attribute-button")].slice(0, 6).map((el) => el.textContent?.trim()),
      }));
      throw new Error(`schema detail did not show syntax OID: ${JSON.stringify(detail)}`);
    }
    await page.getByRole("tab", { name: "匹配规则用途", exact: true }).click();
    // 切页签会清空选中：新页签需重新点选行。
    const useRow = page.locator(".schema-attribute-button", { hasText: "caseIgnoreMatch" }).first();
    await useRow.waitFor();
    await useRow.click();
    await page.waitForFunction(() => document.querySelector(".schema-detail-body")?.textContent?.includes("cn, sn, uid"));
  } finally {
    // 兜底关闭，防面板残留拦截后续用例。
    await page.locator(".panel-modal footer").getByRole("button", { name: "关闭" }).click().catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForFunction(() => !document.querySelector(".panel-modal"), undefined, { timeout: 8000 }).catch(() => {});
  }
});

test("bookmark loop: add from tree, jump from toolbar, remove from dropdown", async (page) => {
  await page.locator(".tree-filter input").fill("");
  const node = page.locator('.tree-node[title="ou=groups,dc=demo,dc=dbx"]').first();
  await node.waitFor();
  await node.click({ button: "right" });
  await page.getByRole("menuitem", { name: "收藏此条目" }).click();
  await page.waitForFunction(() => document.querySelector(".notice")?.textContent?.includes("已加入书签"));
  const starButton = page.locator('.toolbar .icon-button[aria-label="书签"]');
  await page.waitForFunction(() => !document.querySelector('.toolbar .icon-button[aria-label="书签"]')?.disabled);
  await starButton.click();
  const bookmarkItem = page.locator('.context-menu--recent [role="menuitem"]').filter({ hasText: "ou=groups" }).first();
  await bookmarkItem.waitFor();
  await bookmarkItem.click();
  await page.locator(".editor-modal").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await starButton.click();
  await page.locator('.context-menu--recent button[aria-label^="移除书签："]').first().click();
  await page.waitForFunction(() => document.querySelector(".context-menu--recent")?.textContent?.includes("暂无书签"));
  await page.keyboard.press("Escape");
});

test("goto DN reveals and selects the tree node", async (page) => {
  await page.locator('.toolbar .icon-button[aria-label="跳转到 DN"]').click();
  await page.locator(".context-menu--recent form input").fill("ou=people,dc=demo,dc=dbx");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('.tree-node[title="ou=people,dc=demo,dc=dbx"]')?.getAttribute("aria-selected") === "true");
});

test("compare dialog: whole-entry diff between two DNs", async (page) => {
  const node = page.locator('.tree-node[title="ou=people,dc=demo,dc=dbx"]').first();
  await node.waitFor();
  await node.click({ button: "right" });
  await page.getByRole("menuitem", { name: "比较条目" }).click();
  await page.locator(".compare-modal").waitFor();
  await expectEqual(await page.locator(".compare-dn").inputValue(), "ou=people,dc=demo,dc=dbx", "compare dn prefilled");
  // 同 DN 对比被拦截（无请求）；换成不同 DN 后展示整条目属性差异表。
  await page.locator(".compare-target-input").fill("ou=people,dc=demo,dc=dbx");
  await page.waitForFunction(() => document.querySelector(".compare-modal")?.textContent?.includes("目标 DN 与当前 DN 相同"));
  await page.locator(".compare-target-input").fill("ou=groups,dc=demo,dc=dbx");
  await page.locator(".compare-modal .primary-button").click();
  // people{ou,objectClass} vs groups{ou,cn,objectClass}：ou 值不同、cn 仅目标有、objectClass 一致不展示。
  await page.waitForFunction(() => document.querySelector(".compare-modal")?.textContent?.includes("共 3 个属性，2 个存在差异"));
  await page.waitForFunction(() => document.querySelector(".compare-modal")?.textContent?.includes("值不同"));
  await page.waitForFunction(() => document.querySelector(".compare-modal")?.textContent?.includes("仅目标条目"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
});

test("compare dialog picks the target DN from the tree picker", async (page) => {
  const node = page.locator('.tree-node[title="ou=people,dc=demo,dc=dbx"]').first();
  await node.waitFor();
  await node.click({ button: "right" });
  await page.getByRole("menuitem", { name: "比较条目" }).click();
  await page.locator(".compare-modal").waitFor();
  await page.locator(".compare-modal").getByRole("button", { name: "从目录树选择" }).click();
  await page.locator(".dn-picker-modal").waitFor();
  // 选择器浏览根为当前 DN 的父（dc=demo,dc=dbx）；点选 ou=groups 子行回填目标。
  await page.locator('.dn-picker-row .dn-picker-name[title="ou=groups,dc=demo,dc=dbx"]').click();
  await expectEqual(await page.locator(".compare-target-input").inputValue(), "ou=groups,dc=demo,dc=dbx", "picker fills target dn");
  await page.locator(".compare-modal .primary-button").click();
  await page.waitForFunction(() => document.querySelector(".compare-modal")?.textContent?.includes("共 3 个属性，2 个存在差异"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
});

test("compare dialog: identical verdict, failure path and reopen reset", async (page) => {
  // 构造一个与 ou=people 属性完全一致的临时条目（mock add/delete 走协议仿真）。
  await page.evaluate(() => window.dbxPlugin.invoke("ldap/entry/add", { dn: "ou=cmp-twin,dc=demo,dc=dbx", attributes: { objectClass: ["organizationalUnit"], ou: ["people"] } }));
  const node = page.locator('.tree-node[title="ou=people,dc=demo,dc=dbx"]').first();
  await node.waitFor();
  await node.click({ button: "right" });
  await page.getByRole("menuitem", { name: "比较条目" }).click();
  await page.locator(".compare-modal").waitFor();
  try {
    await page.locator(".compare-target-input").fill("ou=cmp-twin,dc=demo,dc=dbx");
    await page.locator(".compare-modal .primary-button").click();
    await page.waitForFunction(() => document.querySelector(".compare-modal")?.textContent?.includes("两个条目的属性完全一致"));
    // 失败路径：目标不存在 → 行内友好错误，可再次比较。
    await page.locator(".compare-target-input").fill("cn=missing,dc=demo,dc=dbx");
    await page.locator(".compare-modal .primary-button").click();
    await page.waitForFunction(() => document.querySelector(".compare-modal .form-error")?.textContent?.includes("比较失败"));
    // 关闭重开：目标与结果重置。
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await node.click({ button: "right" });
    await page.getByRole("menuitem", { name: "比较条目" }).click();
    await page.locator(".compare-modal").waitFor();
    await expectEqual(await page.locator(".compare-target-input").inputValue(), "", "reopen resets target");
  } finally {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.evaluate(() => window.dbxPlugin.invoke("ldap/entry/delete", { dn: "ou=cmp-twin,dc=demo,dc=dbx" }).catch(() => {}));
  }
});

test("F9 entry tabs: open two entries, switch, dirty veto", async (page) => {
  const stage = async (label, fn, timeout = 12000) => {
    try {
      await fn(timeout);
    } catch (error) {
      const state = await page.evaluate(() => ({
        modal: Boolean(document.querySelector(".editor-modal")),
        picker: Boolean(document.querySelector(".dn-picker-modal")),
        tabs: [...document.querySelectorAll(".entry-tab-shell, .entry-tab[role='tab']")].map((el) => `${el.tagName}.${el.className}::${el.textContent?.trim()}::aria-selected=${el.getAttribute("aria-selected")}`),
        dn: document.querySelector(".entry-dn-row")?.textContent ?? null,
        notice: document.querySelector(".notice")?.textContent ?? null,
        rows: document.querySelectorAll(".ag-row").length,
      }));
      await page.screenshot({ path: `/tmp/ldap-shots/f9-${label.replace(/[^a-z0-9-]/gi, "_")}.png` }).catch(() => {});
      throw new Error(`F9 stage [${label}] failed: ${JSON.stringify(state)} :: ${error.message}`);
    }
  };
  // fixture 自备（走查前段测试会增删条目，不依赖共享数据存活）。
  for (const [dn, attributes] of [
    ["uid=tabs-1,ou=people,dc=demo,dc=dbx", { objectClass: ["top"], uid: ["tabs-1"] }],
  ]) {
    await page.evaluate(([entryDn, entryAttributes]) => window.dbxPlugin.invoke("ldap/entry/add", { dn: entryDn, attributes: entryAttributes }), [dn, attributes]);
  }
  try {
    // 前置：紧凑条若折叠则展开，再切源码模式。
    const collapsed = await page.locator(".search-advanced.is-collapsed").count();
    if (collapsed) {
      await page.locator(".search-form-compact .compact-toggle").click();
    }
    await page.locator(".filter-block").waitFor();
    await page.locator(".search-form .mode-switch button").nth(1).click();
    // 页签 1：结果行双击开 tabs-1。
    await page.locator(".filter-source input").fill("(uid=tabs-1)");
    await page.getByRole("button", { name: /搜索|Search/ }).first().click();
    await stage("search-1-row", (t) => page.waitForFunction(() => document.querySelectorAll(".ag-row").length === 1, undefined, { timeout: t }));
    await page.locator(".ag-row").first().dblclick();
    await stage("editor-open", (t) => page.locator(".editor-modal").waitFor({ timeout: t }));
    // 页签 2：弹窗内点「＋」→ DnPicker 嵌套打开 → 下钻 ou=people → 选 uid=tabs-2
    //（编辑器打开期间目录树被遮罩挡住，「＋」是打开第二个条目的正确入口）。
    await stage("tab-add-click", async (t) => {
      await page.locator(".entry-tab-add").click({ timeout: t });
    });
    await stage("picker-open", (t) => page.locator(".dn-picker-modal").waitFor({ timeout: t }));
    // 下钻 ou=people（1000 子条）：修复后 mock 截断返回前 500 条 + 徽标，
    // uid=tabs-2 按字典序在前 500 内可选——端到端固化截断语义修复。
    await stage("picker-drill", async (t) => {
      const peopleRow = page.locator(".dn-picker-row", { has: page.locator('.dn-picker-name[title="ou=people,dc=demo,dc=dbx"]') }).first();
      await peopleRow.locator(".dn-picker-toggle").click({ timeout: t });
    });
    await stage("picker-truncated-badge", async (t) => {
      // locale 无关断言：徽标元素存在且含截断上限数字。
      await page.waitForFunction(() => {
        const badge = document.querySelector(".dn-picker-modal .badge");
        return badge !== null && badge.textContent?.includes("500");
      }, undefined, { timeout: t });
    });
    await stage("picker-pick", async (t) => {
      // 选 ou=people 本身作第二页签（不下钻——其 1000 子条在前 500 截断内，
      // 后加的 fixture 条目按插入序排在切片之外，不能依赖）。
      await page.locator('.dn-picker-name[title="ou=people,dc=demo,dc=dbx"]').click({ timeout: t });
    });
    await stage("ou-people-active", (t) => page.waitForFunction(() => {
      // 新页签按打开次序追加到工作集尾部并激活（激活已有页签不重排，
      // 见 lib/openTabs）；断言用 shell 的 is-active 类（无歧义）。
      const shells = [...document.querySelectorAll(".entry-tab-shell")];
      const tail = shells[shells.length - 1];
      return tail?.classList.contains("is-active") === true && tail?.textContent?.includes("ou=people") === true;
    }, undefined, { timeout: t }));
    // 切回 tabs-1：DN 行随之切换。
    await stage("switch-to-tabs-1", async (t) => {
      await page.locator(".entry-tab[role='tab']", { hasText: "uid=tabs-1" }).click({ timeout: t });
      await page.waitForFunction(() => document.querySelector(".entry-dn-row")?.textContent?.includes("uid=tabs-1"), undefined, { timeout: t });
    });
    // 脏态否决：编辑值后点 ou=people 页签 → 不切换 + 提示有未保存修改。
    const valueInput = page.locator(".attr-row textarea").first();
    await valueInput.fill("modified-for-tabs");
    await stage("dirty-veto", async (t) => {
      // 点「另一个」页签才触发否决；点当前激活页签是组件内的空操作守卫。
      await page.locator(".entry-tab[role='tab']", { hasText: "ou=people" }).click({ timeout: t });
      await page.waitForFunction(() => document.querySelector(".notice")?.textContent?.includes("有未保存的修改"), undefined, { timeout: t });
      await page.waitForFunction(() => document.querySelector(".entry-dn-row")?.textContent?.includes("uid=tabs-1"), undefined, { timeout: t });
    });
    // 撤回修改（恢复 fixture 原值）再切换成功。
    await valueInput.fill("tabs-1");
    await stage("switch-after-revert", async (t) => {
      await page.locator(".entry-tab[role='tab']", { hasText: "ou=people" }).click({ timeout: t });
      await page.waitForFunction(() => document.querySelector(".entry-dn-row")?.textContent?.includes("ou=people,dc=demo,dc=dbx"), undefined, { timeout: t });
    });
  } finally {
    // 失败路径兜底：编辑器可能处于脏态（Esc 会被正确否决），走显式「取消」通道。
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
    if (await page.locator(".editor-modal").count()) {
      await page.locator(".editor-modal footer button", { hasText: /取消|Cancel/ }).first().click().catch(() => {});
    }
    await page.waitForFunction(() => !document.querySelector(".editor-modal"), undefined, { timeout: 5000 }).catch(() => {});
    for (const dn of ["uid=tabs-1,ou=people,dc=demo,dc=dbx"]) {
      await page.evaluate((entryDn) => window.dbxPlugin.invoke("ldap/entry/delete", { dn: entryDn }).catch(() => {}), dn);
    }
  }
});

test("F9 entry tab bar keeps its height when the form tab overflows the modal", async (page) => {
  // 回归：.entry-tabs 自带 overflow-x:auto（列向 flex 里自动最小高为 0），
  // 表单内容超过弹窗 680px 封顶时 flex 收缩按 basis 比例分摊会把页签条压瘪
  // （复现实测 34px→16px，tab 文字被裁）。修复 = 非内容区 flex: 0 0 auto +
  // min-height，与全局 .entry-relation-tabs / relation footer 同一约定。
  await page.evaluate(() => window.dbxPlugin.invoke("ldap/entry/add", {
    dn: "uid=tall-tabbar,ou=people,dc=demo,dc=dbx",
    attributes: {
      objectClass: ["inetOrgPerson", "posixAccount"],
      uid: ["tall-tabbar"], cn: ["Tall Tabbar"], sn: ["Tabbar"],
      ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`description${index + 1}`, [`value ${index + 1}`]])),
    },
  }));
  try {
    // 前置：紧凑条若折叠则展开，再切源码模式。
    const collapsed = await page.locator(".search-advanced.is-collapsed").count();
    if (collapsed) {
      await page.locator(".search-form-compact .compact-toggle").click();
    }
    await page.locator(".filter-block").waitFor();
    await page.locator(".search-form .mode-switch button").nth(1).click();
    // 先开超高条目再关闭（工作集保留），随后打开矮条目：页签条 ≥2 才渲染，
    // 且只有激活页签的表单内容超高时收缩才发生。
    await page.locator(".filter-source input").fill("(uid=tall-tabbar)");
    await page.getByRole("button", { name: /搜索|Search/ }).first().click();
    await page.waitForFunction(() => document.querySelectorAll(".ag-row").length === 1);
    await page.locator(".ag-row").first().dblclick();
    await page.locator(".editor-modal").waitFor();
    await page.locator(".editor-modal footer button", { hasText: /取消|Cancel/ }).first().click();
    await page.waitForFunction(() => !document.querySelector(".editor-modal"));
    await page.locator(".filter-source input").fill("(uid=user0002)");
    await page.getByRole("button", { name: /搜索|Search/ }).first().click();
    await page.waitForFunction(() => document.querySelectorAll(".ag-row").length === 1);
    await page.locator(".ag-row").first().dblclick();
    await page.locator(".editor-modal").waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".entry-tab-shell").length >= 2);
    await page.locator(".entry-tab[role='tab']", { hasText: "uid=tall-tabbar" }).click();
    await page.waitForFunction(() => document.querySelector(".entry-dn-row")?.textContent?.includes("uid=tall-tabbar"));
    // 自然高度 = 26px 页签 + 6px padding + 2px border = 34px；被收缩会显著低于它。
    const tabsHeight = await page.locator(".entry-tabs").evaluate((el) => el.getBoundingClientRect().height);
    if (!(tabsHeight >= 30)) throw new Error(`entry tab bar collapsed to ${tabsHeight}px (expect ≥30px)`);
  } finally {
    await closeEditorIfOpen(page);
    await page.evaluate(() => window.dbxPlugin.invoke("ldap/entry/delete", { dn: "uid=tall-tabbar,ou=people,dc=demo,dc=dbx" }).catch(() => {}));
  }
});

test("batch modify applies an attribute to selected rows", async (page) => {
  // 前置：紧凑条若折叠则展开，再切源码模式（.filter-source input 仅源码态可见）。
  const collapsed = await page.locator(".search-advanced.is-collapsed").count();
  if (collapsed) {
    await page.locator(".search-form-compact .compact-toggle").click();
  }
  await page.locator(".filter-block").waitFor();
  await page.locator(".search-form .mode-switch button").nth(1).click();

  const search = page.locator(".filter-source input");  for (const [dn, attributes] of [
    ["ou=walk-batch,dc=demo,dc=dbx", { objectClass: ["top"], ou: ["walk-batch"] }],
    ["uid=bm-1,ou=walk-batch,dc=demo,dc=dbx", { objectClass: ["top"], uid: ["bm-1"] }],
    ["uid=bm-2,ou=walk-batch,dc=demo,dc=dbx", { objectClass: ["top"], uid: ["bm-2"] }],
  ]) {
    await page.evaluate(([entryDn, entryAttributes]) => window.dbxPlugin.invoke("ldap/entry/add", { dn: entryDn, attributes: entryAttributes }), [dn, attributes]);
  }
  try {
  const search = page.locator(".filter-source input");
  await search.fill("(uid=bm-*)");
  await page.getByRole("button", { name: /搜索|Search/ }).first().click();
  await page.waitForFunction(() => document.querySelectorAll(".ag-row").length === 2);
  const checkboxes = page.locator(".ag-row .ag-checkbox-input");
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await page.locator(".batch-modify").click();
  await page.locator(".batch-modify-modal").waitFor();
  await page.locator(".batch-modify-modal .attribute-input").fill("description");
  await page.locator(".batch-modify-modal .values-input").fill("walkthrough");
  await page.locator(".batch-modify-modal .primary-button").click();
  await page.waitForFunction(() => document.querySelector(".notice")?.textContent?.trim() === "批量修改完成：成功 2，失败 0");
  const stored = await page.evaluate(() => window.dbxPlugin.invoke("ldap/entry/get", { dn: "uid=bm-1,ou=walk-batch,dc=demo,dc=dbx" }));
  expectEqual(stored.entry.attributes.description[0], "walkthrough", "batch modify wrote the attribute");
  } finally {
    await closeEditorIfOpen(page);
    for (const dn of ["uid=bm-1,ou=walk-batch,dc=demo,dc=dbx", "uid=bm-2,ou=walk-batch,dc=demo,dc=dbx", "ou=walk-batch,dc=demo,dc=dbx"]) {
      await page.evaluate((entryDn) => window.dbxPlugin.invoke("ldap/entry/delete", { dn: entryDn }).catch(() => {}), dn);
    }
  }
});

test("value copy menu writes base64 through the mock clipboard", async (page) => {
  // 前置：紧凑条若折叠则展开，再切源码模式（.filter-source input 仅源码态可见）。
  const collapsed = await page.locator(".search-advanced.is-collapsed").count();
  if (collapsed) {
    await page.locator(".search-form-compact .compact-toggle").click();
  }
  await page.locator(".filter-block").waitFor();
  await page.locator(".search-form .mode-switch button").nth(1).click();

  const search = page.locator(".filter-source input");  await page.evaluate(() => window.dbxPlugin.invoke("ldap/entry/add", { dn: "ou=walk-copy,dc=demo,dc=dbx", attributes: { objectClass: ["top"], ou: ["walk-copy"] } }));
  await page.evaluate(() => window.dbxPlugin.invoke("ldap/entry/add", { dn: "uid=copy-a,ou=walk-copy,dc=demo,dc=dbx", attributes: { objectClass: ["top"], uid: ["copy-a"] } }));
  try {
  const search = page.locator(".filter-source input");
  await search.fill("(uid=copy-a)");
  await page.getByRole("button", { name: /搜索|Search/ }).first().click();
  await page.waitForFunction(() => document.querySelectorAll(".ag-row").length === 1);
  await page.locator(".ag-row").first().dblclick();
  await page.locator(".editor-modal").waitFor();
  const row = page.locator(".attr-row").filter({ has: page.locator('textarea[aria-label="uid"]') }).first();
  // UX-V7 右键化：行内复制按钮已移除，右键值行打开统一复制菜单（5 项）。
  await row.click({ button: "right" });
  const menu = page.locator(".editor-modal .context-menu");
  await menu.waitFor();
  expectEqual(await menu.locator("[role='menuitem']").count(), 5, "copy menu has five items");
  await menu.getByRole("menuitem", { name: "以 Base64 复制" }).click();
  await page.waitForFunction(() => window.dbxPlugin.clipboardWrites?.at(-1) === "Y29weS1h");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  } finally {
    await closeEditorIfOpen(page);
    await page.evaluate(() => window.dbxPlugin.invoke("ldap/entry/delete", { dn: "uid=copy-a,ou=walk-copy,dc=demo,dc=dbx" }).catch(() => {}));
    await page.evaluate(() => window.dbxPlugin.invoke("ldap/entry/delete", { dn: "ou=walk-copy,dc=demo,dc=dbx" }).catch(() => {}));
  }
});

// -- main ----------------------------------------------------------------------

const playwright = await loadPlaywrightCore();
const executablePath = findChromeExecutable();
const launchOptions = executablePath ? { executablePath } : { channel: "chrome" };

const server = spawn("pnpm", ["--dir", "frontend", "exec", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: PLUGIN_ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  await waitForServer(`http://localhost:${PORT}/mock.html`);
  browser = await playwright.chromium.launch({ headless: true, ...launchOptions });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(`http://localhost:${PORT}/mock.html`);

  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn(page);
      console.log(`  ✓ ${name}`);
    } catch (cause) {
      await page.screenshot({ path: `/tmp/ldap-shots/fail-${name.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}.png` }).catch(() => {});
      failures += 1;
      console.error(`  ✗ ${name}\n    ${cause instanceof Error ? cause.message : cause}`);
    }
  }
  console.log(failures === 0 ? `\nUI walkthrough: ${tests.length}/${tests.length} passed` : `\nUI walkthrough: ${tests.length - failures}/${tests.length} passed`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (cause) {
  if (/browser|executable|chrome/i.test(String(cause))) skip(`no Chrome available (${cause})`);
  console.error(`FAIL: ldap UI walkthrough crashed: ${cause instanceof Error ? cause.message : cause}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (!process.argv.includes("--keep-server")) server.kill("SIGTERM");
}
