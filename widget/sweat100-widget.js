// 100 Days of Sweat — iPhone home-screen widget for the Scriptable app
// 1. Install "Scriptable" from the App Store
// 2. New script → paste this file → set SITE below
// 3. Long-press home screen → + → Scriptable → pick Small or Medium → Edit widget → Script: this one
//    (Lock-screen widgets work too: pick Scriptable in the lock-screen widget gallery)

const SITE = "https://sweat100.YOUR-SUBDOMAIN.workers.dev"; // ← change to your URL

const C = {
  bg: new Color("#0d0e11"), text: new Color("#f3f2ee"), muted: new Color("#8b909a"),
  heat: new Color("#ff5b35"), reel: new Color("#2fd3a6"), line: new Color("#2a2e37"), missed: new Color("#1e2128"),
};

async function getJSON(path) {
  const r = new Request(SITE + path);
  r.timeoutInterval = 15;
  return r.loadJSON();
}

function fmt(n) {
  if (n == null) return "–";
  return n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k" : String(n);
}

// 100 squares, like the paper sheet
function gridImage(days, size) {
  const cols = 20, rows = 5, gap = 3;
  const cell = (size.width - gap * (cols - 1)) / cols;
  const h = rows * cell + gap * (rows - 1);
  const dc = new DrawContext();
  dc.size = new Size(size.width, h);
  dc.opaque = false;
  dc.respectScreenScale = true;
  days.forEach((d, i) => {
    const x = (i % cols) * (cell + gap), y = Math.floor(i / cols) * (cell + gap);
    const path = new Path();
    path.addRoundedRect(new Rect(x, y, cell, cell), 2.5, 2.5);
    dc.addPath(path);
    if (d.status === "done") {
      dc.setFillColor(C.heat); dc.fillPath();
      if (d.full) { // workout + Reel: green corner, as on the dashboard
        const corner = new Path();
        corner.addLines([new Point(x + cell, y + cell * 0.45), new Point(x + cell, y + cell), new Point(x + cell * 0.45, y + cell)]);
        corner.closeSubpath();
        dc.addPath(corner); dc.setFillColor(C.reel); dc.fillPath();
      }
    }
    else if (d.status === "today") { dc.setStrokeColor(C.text); dc.setLineWidth(1.5); dc.strokePath(); }
    else if (d.status === "missed") { dc.setFillColor(C.missed); dc.fillPath(); }
    else { dc.setStrokeColor(C.line); dc.setLineWidth(1); dc.strokePath(); }
  });
  return dc.getImage();
}

async function build() {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = SITE;
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  const family = config.widgetFamily || "medium";

  let s, d;
  try {
    s = await getJSON("/api/summary");
    if (family === "medium" || family === "large") d = await getJSON("/api/days");
  } catch (e) {
    const t = w.addText("Can't reach the tracker");
    t.textColor = C.muted; t.font = Font.mediumSystemFont(12);
    return w;
  }

  // Lock-screen widgets
  if (family === "accessoryCircular") {
    w.addAccessoryWidgetBackground = true;
    const t = w.addText(String(s.day)); t.font = Font.heavySystemFont(20); t.centerAlignText();
    const u = w.addText(s.done_today ? "✓" : "○"); u.font = Font.boldSystemFont(12); u.centerAlignText();
    return w;
  }
  if (family === "accessoryRectangular" || family === "accessoryInline") {
    const t = w.addText(`Day ${s.day}/${s.total} ${s.done_today ? "✓" : "○"} · 🔥${s.streak}${s.reel_today ? " · 🎬" : ""}`);
    t.font = Font.boldSystemFont(13);
    if (family === "accessoryRectangular") {
      const u = w.addText(s.done_today ? (s.today_activity || "Done") : "Workout still open");
      u.font = Font.systemFont(12);
    }
    return w;
  }

  w.setPadding(14, 14, 12, 14);
  const top = w.addStack(); top.centerAlignContent();
  const eb = top.addText("100 DAYS OF SWEAT"); eb.font = Font.heavySystemFont(9); eb.textColor = C.heat;
  top.addSpacer();
  if (family !== "small") { const st = top.addText(`🔥 ${s.streak}`); st.font = Font.boldSystemFont(12); st.textColor = C.text; }

  w.addSpacer(4);
  const dayRow = w.addStack(); dayRow.bottomAlignContent();
  const big = dayRow.addText(`Day ${s.day}`); big.font = Font.heavySystemFont(family === "small" ? 30 : 34); big.textColor = C.text; big.minimumScaleFactor = 0.6;
  const of = dayRow.addText(` /${s.total}`); of.font = Font.boldSystemFont(13); of.textColor = C.muted;

  w.addSpacer(4);
  const status = w.addStack(); status.spacing = 10;
  const a = status.addText(s.done_today ? "● Workout" : "○ Workout"); a.font = Font.semiboldSystemFont(12); a.textColor = s.done_today ? C.heat : C.muted;
  const r = status.addText(s.reel_today ? "● Reel" : "○ Reel"); r.font = Font.semiboldSystemFont(12); r.textColor = s.reel_today ? C.reel : C.muted;

  if (family === "small") {
    w.addSpacer();
    const st = w.addText(`🔥 ${s.streak} streak · ${fmt(s.total_views)} views`); st.font = Font.mediumSystemFont(11); st.textColor = C.muted;
    st.minimumScaleFactor = 0.7;
    return w;
  }

  w.addSpacer(8);
  const img = w.addImage(gridImage(d.days, new Size(300, 0)));
  img.imageSize = new Size(300, 300 / 20 * 5 + 12);
  w.addSpacer();
  const foot = w.addStack();
  const f = foot.addText(`${s.days_done} done · ${fmt(s.total_minutes)} min · ${s.reels} reels · ${fmt(s.total_views)} views`);
  f.font = Font.mediumSystemFont(11); f.textColor = C.muted; f.minimumScaleFactor = 0.7;
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
