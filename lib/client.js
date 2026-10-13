/**
 * dsh-auto-email — browser half.
 *
 * Adds an "AI 日报" button to the sidebar footer. The panel it opens shows
 * whether the daily send is armed, lets the user run a preview or send now,
 * edits non-secret settings, and stores credentials — which never travel
 * through a tool call or the conversation.
 *
 * Two contracts from the renderer shape this file, and both are easy to get
 * wrong (see the comments on `apply` below): the footer slot must be reached
 * through `ctx.slots.inject` rather than a bare `register`, and the registered
 * value must be a React *component*.
 *
 * Written with `React.createElement` rather than JSX because the host loads this
 * file through `window.__ModuleLoader__` with no build step.
 */
window.__ModuleLoader__.load({
	id: "dsh-auto-email",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

const React = require("react");
const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

const { Button, Modal, Pill, Switch, Toast, Tooltip, IconRefreshOutlineRegular, IconSlidersTwoOutlineRegular } = primitives;

const e = React.createElement;

/** Host route prefix; every path below is registered by the host half. */
const BASE = "/api/dsh-auto-email";

/** Marks the footer button so a re-apply replaces it instead of stacking. */
const BUTTON_ATTR = "data-dsh-auto-email-button";

/** Single `<style>` element owned by this plugin. */
const STYLE_ID = "dsh-auto-email-style";

/** Slot id for the footer row. */
const SLOT_ID = "auto-email";

/** How often to re-read host status while a run is in flight. */
const POLL_MS = 4000;

const CSS = `
.dae-button {
	appearance: none;
	box-sizing: border-box;
	display: flex;
	align-items: center;
	gap: 8px;
	width: calc(100% + 4px);
	height: 42px;
	margin: 2px -2px 0;
	padding: 0 10px 0 8px;
	font: inherit;
	font-size: 14px;
	line-height: 22px;
	color: var(--dsw-alias-label-primary, #202124);
	background: transparent;
	border: 0;
	border-radius: var(--dsw-radius-md, 8px);
	cursor: pointer;
	overflow: hidden;
}
.dae-button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(32, 33, 36, 0.08)); }
.dae-button:focus-visible { outline: 2px solid #4d6bfe; outline-offset: -2px; }
.dae-button-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dae-button[data-dae-warn]::after {
	content: "!";
	margin-left: auto;
	width: 16px;
	height: 16px;
	font-size: 11px;
	font-weight: 700;
	line-height: 16px;
	text-align: center;
	color: var(--dsw-alias-label-warning, #b54708);
	background: var(--dsw-alias-fill-warning, rgba(181, 71, 8, 0.12));
	border-radius: 8px;
}
.dae-button[data-dae-busy]::after {
	content: attr(data-dae-busy);
	margin-left: auto;
	font-size: 12px;
	color: var(--dsw-alias-label-secondary, #73777f);
}

.dae-panel { width: min(620px, 84vw); max-height: min(660px, 78vh); }
/* The Modal owns its own scroll region; make it the only one and let the inner
   column carry layout only, so nothing scrolls twice. */
.dae-scroll { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow: hidden; }
.dae-scroll > * { min-height: 0; }
.dae-body { display: flex; flex-direction: column; gap: 14px; overflow: auto; flex: 1; padding-right: 2px; }

.dae-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--dsw-alias-label-secondary, #73777f); }
.dae-head strong { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #202124); }

.dae-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px 14px; }
.dae-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dae-cell > dt { font-size: 12px; color: var(--dsw-alias-label-secondary, #73777f); }
.dae-cell > dd { margin: 0; font-size: 13px; color: var(--dsw-alias-label-primary, #202124); overflow-wrap: anywhere; }

.dae-group { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-line-divider, rgba(32, 33, 36, 0.08)); }
.dae-group > h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #73777f); }

.dae-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 12px; }
.dae-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dae-field > label { font-size: 12px; color: var(--dsw-alias-label-secondary, #73777f); }
.dae-field > input {
	box-sizing: border-box;
	width: 100%;
	height: 32px;
	padding: 0 8px;
	font: inherit;
	font-size: 13px;
	color: var(--dsw-alias-label-primary, #202124);
	background: var(--dsw-alias-fill-secondary, rgba(32, 33, 36, 0.06));
	border: 1px solid var(--dsw-alias-line-divider, rgba(32, 33, 36, 0.12));
	border-radius: var(--dsw-radius-sm, 6px);
}
.dae-field > input:focus-visible { outline: 2px solid #4d6bfe; outline-offset: -2px; }
.dae-field > span { font-size: 11px; color: var(--dsw-alias-label-secondary, #73777f); }

.dae-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dae-actions > .dae-grow { flex: 1; min-width: 0; }

.dae-note { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #73777f); }
.dae-note.is-error { color: var(--dsw-alias-label-error, #d93025); }
.dae-note.is-ok { color: var(--dsw-alias-label-success, #137333); }
.dae-note code { font-size: 11px; overflow-wrap: anywhere; }

.dae-story { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-top: 1px solid var(--dsw-alias-line-divider, rgba(32, 33, 36, 0.08)); }
.dae-story:first-child { border-top: 0; }
.dae-story-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #202124); }
.dae-story-meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #73777f); overflow-wrap: anywhere; }
.dae-story-meta a { color: inherit; }
.dae-story-text { font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-primary, #202124); }
.dae-story-text b { color: var(--dsw-alias-label-secondary, #73777f); font-weight: 600; }

.dae-runs { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary, #73777f); }
.dae-runs > div { display: flex; gap: 6px; }
.dae-runs > div > span:first-child { flex: none; width: 132px; }
.dae-runs > div > span:last-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dae-frame { width: 100%; height: 340px; border: 1px solid var(--dsw-alias-line-divider, rgba(32, 33, 36, 0.12)); border-radius: var(--dsw-radius-sm, 6px); background: #fff; }
`;

/** Keep exactly one copy of our stylesheet, even across hot reloads. */
function ensureStyle() {
	let style = document.getElementById(STYLE_ID);
	if (style === null) {
		style = document.createElement("style");
		style.id = STYLE_ID;
		document.head.appendChild(style);
	}
	if (style.textContent !== CSS) style.textContent = CSS;
}

//#region ------------------------------------------------------------------ host data

/** POST JSON to a host route and unwrap the `{ ok, ... }` envelope. */
async function post(path, body) {
	const response = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify(body ?? {})
	});
	const payload = await response.json().catch(() => ({}));
	if (payload?.ok !== true) throw new Error(String(payload?.error ?? `${path} → HTTP ${response.status}`));
	return payload;
}

async function fetchStatus() {
	const response = await fetch(`${BASE}/status`, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`${BASE}/status → HTTP ${response.status}`);
	const payload = await response.json();
	if (payload?.ok !== true) throw new Error(String(payload?.error ?? "宿主拒绝了该请求"));
	return payload.status;
}

/** Read the rendered email for one date, for the in-panel preview. */
async function fetchArchive(date) {
	const response = await fetch(`${BASE}/archive?date=${encodeURIComponent(date)}`, { headers: { accept: "application/json" } });
	const payload = await response.json().catch(() => ({}));
	if (payload?.ok !== true) throw new Error(String(payload?.error ?? "no archive"));
	return payload;
}

/** Host status plus a reload callback; polls while a run is in flight. */
function useStatus(open) {
	const [state, setState] = React.useState({ loading: false, data: undefined, error: undefined });
	const reload = React.useCallback(async () => {
		setState((previous) => ({ loading: true, data: previous.data, error: undefined }));
		try {
			const data = await fetchStatus();
			setState({ loading: false, data, error: undefined });
			return data;
		} catch (error) {
			setState({ loading: false, data: undefined, error: String(error?.message ?? error) });
			return undefined;
		}
	}, []);
	React.useEffect(() => {
		if (open) void reload();
	}, [open, reload]);
	// Poll only while the host reports a run in progress, then stop.
	const running = state.data?.running === true;
	React.useEffect(() => {
		if (!open || !running) return undefined;
		const handle = window.setInterval(() => void reload(), POLL_MS);
		return () => window.clearInterval(handle);
	}, [open, running, reload]);
	return [state, reload];
}

//#endregion

//#region ------------------------------------------------------------------ pieces

/** One labelled text input. `type` lets the credential fields mask. */
function Field({ label, value, onChange, placeholder, hint, type }) {
	return e(
		"div",
		{ className: "dae-field" },
		e("label", null, label),
		e("input", {
			type: type ?? "text",
			value: value ?? "",
			placeholder: placeholder ?? "",
			spellCheck: false,
			autoComplete: "off",
			onChange: (event) => onChange(event.target.value)
		}),
		hint === undefined ? null : e("span", null, hint)
	);
}

/** One label/value pair in the status grid. */
function Cell({ label, children }) {
	return e("dl", { className: "dae-cell" }, e("dt", null, label), e("dd", null, children));
}

/** The three-story list with each story's interpretation. */
function StoryList({ stories }) {
	if (!Array.isArray(stories) || stories.length === 0) {
		return e("div", { className: "dae-note" }, "本次没有选出条目。");
	}
	return e(
		"div",
		null,
		stories.map((story, index) =>
			e(
				"div",
				{ className: "dae-story", key: `${index}-${story.url ?? story.headline}` },
				e(
					"div",
					{ className: "dae-story-title" },
					e("span", null, `${index + 1}. ${story.headline}`),
					story.topic_label === undefined || story.topic_label === "" ? null : e(Pill, null, story.topic_label),
					story.aged === true ? e(Pill, null, "回溯") : null
				),
				e(
					"div",
					{ className: "dae-story-meta" },
					`${story.source ?? ""}（T${story.tier ?? "?"}）｜重要性 ${story.importance ?? "-"}｜新颖度 ${story.novelty ?? "-"}｜${story.actual_len ?? 0}/${story.budget ?? 0} 字　`,
					e("a", { href: story.url, target: "_blank", rel: "noreferrer" }, "原文")
				),
				story.fact === "" ? null : e("div", { className: "dae-story-text" }, e("b", null, "📌 事实："), story.fact),
				story.why === "" ? null : e("div", { className: "dae-story-text" }, e("b", null, "🔍 为什么重要："), story.why),
				story.impact === "" ? null : e("div", { className: "dae-story-text" }, e("b", null, "🎯 对你的影响："), story.impact),
				story.doubt === "" ? null : e("div", { className: "dae-story-text" }, e("b", null, "⚖️ 存疑点："), story.doubt)
			)
		)
	);
}

//#endregion

//#region ------------------------------------------------------------------ panel

function Panel({ open, onClose }) {
	const [state, reload] = useStatus(open);
	const [note, setNote] = React.useState(undefined);
	const [busy, setBusy] = React.useState("");
	const [error, setError] = React.useState(undefined);
	const [outcome, setOutcome] = React.useState(undefined);
	const [form, setForm] = React.useState(undefined);
	const [cred, setCred] = React.useState({ deepseek_api_key: "", smtp_auth_code: "", smtp_username: "" });
	const [frame, setFrame] = React.useState(undefined);

	const status = state.data;

	// Seed the editable form from the host once per open, so typing is not
	// clobbered by the status poll.
	React.useEffect(() => {
		if (!open || status === undefined) return;
		setForm((previous) => previous ?? {
			time: status.schedule.time,
			timezone: status.schedule.timezone,
			to: (status.email.to ?? []).join(", "),
			top_n: String(status.digest.top_n),
			min_importance: String(status.digest.min_importance),
			window_hours: String(status.digest.window_hours)
		});
	}, [open, status]);
	React.useEffect(() => {
		if (!open) { setForm(undefined); setOutcome(undefined); setError(undefined); setFrame(undefined); }
	}, [open]);

	// A finished run arrives through the polled status, not through the POST.
	React.useEffect(() => {
		const finished = status?.last_outcome;
		if (finished === undefined || finished === null) return;
		setOutcome((previous) => (previous?.at === finished.at ? previous : finished));
	}, [status]);

	const update = (key) => (value) => setForm((previous) => ({ ...previous, [key]: value }));

	const run = async (dryRun) => {
		setBusy(dryRun ? "preview" : "send");
		setError(undefined);
		try {
			await post("/run", { dry_run: dryRun });
			setNote(dryRun ? "已开始生成预览，约需 3-7 分钟…" : "已开始发送，约需 3-7 分钟…");
			await reload();
		} catch (failure) {
			setError(String(failure?.message ?? failure));
		} finally {
			setBusy("");
		}
	};

	const saveSettings = async () => {
		setBusy("config");
		setError(undefined);
		try {
			const payload = await post("/config", {
				set: {
					"schedule.time": form.time,
					"schedule.timezone": form.timezone,
					"email.to": form.to.split(/[,，;；\s]+/).map((item) => item.trim()).filter(Boolean),
					"digest.top_n": Number(form.top_n) || 3,
					"digest.min_importance": Number(form.min_importance) || 6,
					"digest.window_hours": Number(form.window_hours) || 26
				}
			});
			setNote(`已保存：${(payload.saved ?? []).join("、") || "无变化"}`);
			await reload();
		} catch (failure) {
			setError(String(failure?.message ?? failure));
		} finally {
			setBusy("");
		}
	};

	const saveCredentials = async () => {
		setBusy("secret");
		setError(undefined);
		try {
			const patch = {};
			if (cred.deepseek_api_key.trim() !== "") patch.deepseek_api_key = cred.deepseek_api_key.trim();
			if (cred.smtp_auth_code.trim() !== "") patch.smtp_auth_code = cred.smtp_auth_code.trim();
			if (cred.smtp_username.trim() !== "") patch.smtp_username = cred.smtp_username.trim();
			if (Object.keys(patch).length === 0) throw new Error("没有填写任何需要保存的内容");
			await post("/secret", patch);
			setCred({ deepseek_api_key: "", smtp_auth_code: "", smtp_username: "" });
			setNote("凭据已写入密钥文件，字段已清空。");
			await reload();
		} catch (failure) {
			setError(String(failure?.message ?? failure));
		} finally {
			setBusy("");
		}
	};

	const testSmtp = async () => {
		setBusy("smtp");
		setError(undefined);
		try {
			const payload = await post("/test-smtp", {});
			setNote(`SMTP 连接与登录成功：${payload.greeting ?? ""}`);
		} catch (failure) {
			setError(String(failure?.message ?? failure));
		} finally {
			setBusy("");
		}
	};

	const showMail = async (date) => {
		setError(undefined);
		try {
			const payload = await fetchArchive(date);
			setFrame({ date, html: payload.html });
		} catch (failure) {
			setError(String(failure?.message ?? failure));
		}
	};

	const running = status?.running === true;
	const problems = status?.problems ?? [];

	return e(
		Modal,
		{ open, onClose, title: "AI 每日三报", closeLabel: "关闭", className: "dae-panel", contentClassName: "dae-scroll" },
		e(
			"div",
			{ className: "dae-head" },
			e("strong", null, "AI 每日三报"),
			e("span", null, status === undefined ? "正在读取…" : `${status.enabled ? `已开启，每天 ${status.schedule.time}` : "已停用"}（${status.schedule.timezone}）`),
			running ? e(Pill, null, "运行中") : null
		),

		e(
			"div",
			{ className: "dae-body" },

			state.error === undefined ? null : e("div", { className: "dae-note is-error" }, `读取状态失败：${state.error}`),
			problems.length === 0 ? null : e(
				"div",
				{ className: "dae-note is-error" },
				"配置尚未完整：",
				e("br", null),
				problems.join("；")
			),
			error === undefined ? null : e("div", { className: "dae-note is-error" }, error),

			status === undefined ? null : e(
				"div",
				{ className: "dae-grid" },
				e(Cell, { label: "当前状态" }, status.due ? "待发送" : (status.running ? "正在生成" : "已就绪")),
				e(Cell, { label: "下次推送" }, status.next_run_at),
				e(Cell, { label: "上次发送" }, status.state.last_sent_at || "尚未发送"),
				e(Cell, { label: "跨天去重记忆" }, `${status.state.seen_count} 条`),
				e(Cell, { label: "收件人" }, (status.email.to ?? []).join(", ") || "未配置"),
				e(Cell, { label: "模型" }, `${status.llm.model}${status.llm.api_key_set ? "" : "（缺少 API Key）"}`),
				e(Cell, { label: "存档目录" }, e("code", null, status.paths.archiveDir)),
				status.state.last_error === "" ? null : e(Cell, { label: "上次错误" }, status.state.last_error)
			),

			e(
				"div",
				{ className: "dae-group" },
				e("h4", null, "快捷操作"),
				e(
					"div",
					{ className: "dae-actions" },
					e(Button, { variant: "primary", size: "sm", disabled: running || busy !== "", onClick: () => void run(false), children: busy === "send" ? "启动中…" : "立即发送" }),
					e(Button, { size: "sm", disabled: running || busy !== "", onClick: () => void run(true), children: busy === "preview" ? "启动中…" : "生成预览（不发信）" }),
					e(Button, { variant: "ghost", size: "sm", disabled: busy !== "", onClick: () => void testSmtp(), children: busy === "smtp" ? "测试中…" : "测试 SMTP" }),
					e("span", { className: "dae-grow" }),
					e(Tooltip, { label: "重新读取" }, e(Button, { variant: "ghost", size: "sm", icon: e(IconRefreshOutlineRegular, null), disabled: state.loading, onClick: () => void reload(), children: "刷新" }))
				),
				e("div", { className: "dae-note" }, running ? "正在运行，完成后此处会显示结果。可以关闭本窗口，运行会继续。" : "一次运行会抓取约十个信源并调用模型，通常需要 3-7 分钟。")
			),

			outcome === undefined || outcome === null ? null : e(
				"div",
				{ className: "dae-group" },
				e("h4", null, outcome.ok ? `本次结果（${outcome.at}）` : `本次失败（${outcome.at}）`),
				outcome.ok === false ? e("div", { className: "dae-note is-error" }, outcome.error) : null,
				outcome.ok === true ? e("div", { className: "dae-note is-ok" }, `${outcome.sent ? "已投递" : (outcome.skipped === "dry-run" ? "预览（未发送）" : "未发送")}　${outcome.subject}`) : null,
				outcome.ok === true && outcome.date !== "" ? e("div", { className: "dae-actions" }, e(Button, { size: "sm", variant: "ghost", onClick: () => void showMail(outcome.date), children: "查看邮件全文" })) : null,
				outcome.ok === true ? e(StoryList, { stories: outcome.stories }) : null
			),

			frame === undefined ? null : e(
				"div",
				{ className: "dae-group" },
				e("h4", null, `邮件全文（${frame.date}）`),
				e("iframe", { className: "dae-frame", sandbox: "", srcDoc: frame.html, title: `邮件 ${frame.date}` }),
				e("div", { className: "dae-actions" }, e(Button, { size: "sm", variant: "ghost", onClick: () => setFrame(undefined), children: "收起" }))
			),

			form === undefined ? null : e(
				"div",
				{ className: "dae-group" },
				e("h4", null, "设置"),
				e(
					"div",
					{ className: "dae-form" },
					e(Field, { label: "每日推送时间", value: form.time, onChange: update("time"), hint: "24 小时制，例如 08:00" }),
					e(Field, { label: "时区", value: form.timezone, onChange: update("timezone"), hint: "IANA 名称，例如 Asia/Shanghai" }),
					e(Field, { label: "收件人", value: form.to, onChange: update("to"), hint: "多个地址用逗号或空格分隔" }),
					e(Field, { label: "每天条数", value: form.top_n, onChange: update("top_n"), hint: "默认 3" }),
					e(Field, { label: "重要性门槛", value: form.min_importance, onChange: update("min_importance"), hint: "0-10，越高越挑剔，越容易回溯" }),
					e(Field, { label: "主时间窗（小时）", value: form.window_hours, onChange: update("window_hours"), hint: "默认 26，不足时自动回退到 48/72" })
				),
				e("div", { className: "dae-actions" }, e(Button, { size: "sm", disabled: busy !== "", onClick: () => void saveSettings(), children: busy === "config" ? "保存中…" : "保存设置" }))
			),

			e(
				"div",
				{ className: "dae-group" },
				e("h4", null, "凭据（写入密钥文件，不经由对话传递）"),
				e(
					"div",
					{ className: "dae-form" },
					e(Field, { label: "DeepSeek API Key", value: cred.deepseek_api_key, onChange: (value) => setCred((previous) => ({ ...previous, deepseek_api_key: value })), placeholder: status?.llm.api_key_set ? "已配置（留空则不修改）" : "sk-…", type: "password" }),
					e(Field, { label: "SMTP 授权码", value: cred.smtp_auth_code, onChange: (value) => setCred((previous) => ({ ...previous, smtp_auth_code: value })), placeholder: status?.email.auth_code_set ? "已配置（留空则不修改）" : "QQ 邮箱授权码", type: "password" }),
					e(Field, { label: "发件邮箱账号", value: cred.smtp_username, onChange: (value) => setCred((previous) => ({ ...previous, smtp_username: value })), placeholder: status?.email.username || "you@qq.com" })
				),
				e("div", { className: "dae-actions" }, e(Button, { size: "sm", disabled: busy !== "", onClick: () => void saveCredentials(), children: busy === "secret" ? "保存中…" : "保存凭据" })),
				e("div", { className: "dae-note" }, "密钥文件：", e("code", null, status?.paths.secretFile ?? "…"))
			),

			status === undefined || (status.state.recent_runs ?? []).length === 0 ? null : e(
				"div",
				{ className: "dae-group" },
				e("h4", null, "最近运行"),
				e(
					"div",
					{ className: "dae-runs" },
					status.state.recent_runs.map((entry, index) => e(
						"div",
						{ key: index },
						e("span", null, entry.at),
						e("span", { title: entry.error ?? "" }, `${entry.sent ? "已发送" : "失败"}　${entry.picked} 条　${entry.error ?? ""}`)
					))
				)
			)
		),

		e(
			"div",
			{ className: "dae-actions" },
			e("span", { className: "dae-grow dae-note" }, "开关本插件即可启停每日推送。停用后不会发送，也不会抓取。"),
			e(Tooltip, { label: "重新读取" }, e(Button, { variant: "ghost", size: "sm", icon: e(IconRefreshOutlineRegular, null), disabled: state.loading, onClick: () => void reload(), children: "刷新" }))
		),

		note === undefined ? null : e(Toast, { text: note, tone: "success", onDone: () => setNote(undefined) })
	);
}

//#endregion

//#region ------------------------------------------------------------------ button

/** The footer slot entry. Registered as a component, so it gets the renderer's kit as props. */
function FooterButton() {
	const [open, setOpen] = React.useState(false);
	const [state, setState] = React.useState(undefined);
	React.useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const data = await fetchStatus();
				if (alive) setState(data);
			} catch {
				if (alive) setState(undefined);
			}
		})();
		return () => { alive = false; };
	}, []);
	const warn = (state?.problems ?? []).length > 0;
	return e(
		React.Fragment,
		null,
		e(
			Tooltip,
			{ label: "AI 每日三报：每日推送三条 AI 技术动态到邮箱" },
			e(
				"button",
				{
					type: "button",
					className: "dae-button",
					[BUTTON_ATTR]: "",
					"data-dae-warn": warn ? "" : undefined,
					"data-dae-busy": state?.running === true ? "运行中" : undefined,
					"aria-label": "AI 每日三报",
					onClick: () => setOpen(true)
				},
				e(IconSlidersTwoOutlineRegular, { size: 16 }),
				e("span", { className: "dae-button-label" }, "AI 日报")
			)
		),
		e(Panel, { open, onClose: () => setOpen(false) })
	);
}

//#endregion

//#region ------------------------------------------------------------------ apply

/** Required client services: `slots` is the renderer's slot registry. */
const inject = ["slots"];

/**
 * Register the footer button.
 *
 * Two contracts have to hold at once, and both are easy to get wrong:
 *
 * 1. `sidebar.footer.action` is declared by the built-in sidebar entry, which
 *    mounts during React render — after plugin load. A bare
 *    `ctx.slots.register()` here races that declaration and dies with
 *    `slot "sidebar.footer.action" is not declared`. `ctx.slots.inject(key,
 *    factory)` instead runs the factory once the declaration exists, or holds it
 *    until the declaring entry commits it.
 * 2. The registry value must be a React *component*: the renderer mounts it as
 *    `jsx(Comp, { ...kit, ...injected, ...props })`, so handing it a detached
 *    host element renders nothing.
 *
 * @param ctx - client plugin context.
 */
function apply(ctx) {
	ctx.effect(() => {
		ensureStyle();
		return ctx.slots.inject("sidebar.footer.action", () => {
			document.querySelectorAll(`[${BUTTON_ATTR}]`).forEach((node) => node.remove());
			const dispose = ctx.slots.register(
				{ name: "sidebar.footer.action", id: SLOT_ID, order: 901, label: "AI 日报" },
				FooterButton
			);
			return () => { if (typeof dispose === "function") dispose(); };
		});
	}, "dsh-auto-email: sidebar footer button");
}

//#endregion

exports.apply = apply;
exports.inject = inject;

		return module.exports;
	}
});
