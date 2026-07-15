#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const target = path.resolve(__dirname, "../web/AppLockerUI.json");
const doc = JSON.parse(fs.readFileSync(target, "utf8"));
const containers = new Set(["window", "section", "toolbar", "menubar", "titlebar", "splitpane", "composite"]);
const normalizeAlign = (value) => ({ left: "start", right: "end" }[value] ||
  (["start", "center", "end", "stretch"].includes(value) ? value : "start"));

// Always derive the compact proof from the regular source so reruns are stable.
doc.shapes = doc.shapes.filter((shape) => shape.variantLabel !== "Compact" && !String(shape.id || "").startsWith("compact_"));
const regularRoot = doc.shapes.find((shape) => shape.widget === "window" && !shape.parent);
if (!regularRoot) throw new Error("AppLockerUI has no root Window");

for (const shape of doc.shapes) {
  shape.textOverflow ||= "wrap";
  if (containers.has(shape.widget)) {
    shape.align = normalizeAlign(shape.align);
    shape.justify ||= "start";
  }
  if (shape.widget === "section") {
    shape.showCaption = !!String(shape.text || "").trim() && shape.text !== "Section";
  }
  if (/description$/i.test(shape.name || "")) {
    shape.sizeModeX = "fill";
    shape.sizeModeY = "hug";
    shape.textOverflow = "wrap";
  }
  if (["Page title", "Page subtitle", "Authentication title"].includes(shape.name)) {
    shape.sizeModeX = "fill";
    shape.textOverflow = "wrap";
  }
  if (shape.name === "Page subtitle") shape.sizeModeY = "hug";
  if (shape.name === "Enrolled faces summary") {
    shape.sizeModeX = "fill";
    shape.sizeModeY = "fixed";
    shape.textOverflow = "ellipsis";
  }
  if (["Face unlock card", "Authentication card"].includes(shape.name)) shape.sizeModeY = "hug";
  if (shape.name === "Action bar") {
    shape.align = "center";
    shape.justify = "end";
    shape.showCaption = false;
  }
  if (shape.name === "Settings navigation") {
    shape.hideBelow = 600;
    shape.interactionEnabled = true;
    shape.interactionControl = "Back";
  }
  if (shape.name === "Security page") shape.interactionEnabled = true;
  if (shape.widget === "button" && shape.toolkit === "gtk4") {
    shape.padding = { t: 6, r: 12, b: 6, l: 12 };
  }
}

const actions = new Map([
  ["Stop service", "Stop"],
  ["Manage faces", "Edit Faces"],
  ["Revert changes", "Revert"],
  ["Apply changes", "Apply"],
]);
for (const shape of doc.shapes) {
  if (!actions.has(shape.name)) continue;
  Object.assign(shape, {
    text: actions.get(shape.name), w: 120, h: 34,
    sizeModeX: "fixed", sizeModeY: "fixed", textOverflow: "clip",
    padding: { t: 6, r: 12, b: 6, l: 12 },
  });
}

regularRoot.variantLabel = "Regular";
const titlebar = doc.shapes.find((shape) => shape.parent === regularRoot.id && shape.widget === "titlebar");
if (!titlebar) throw new Error("AppLockerUI has no title bar");
if (!doc.shapes.some((shape) => shape.parent === titlebar.id && shape.name === "Back")) {
  for (const shape of doc.shapes) if (shape.parent === titlebar.id) shape.slot = (Number(shape.slot) || 0) + 1;
  doc.shapes.push({
    type: "widget", id: "el_back", parent: titlebar.id, slot: 0, widget: "toolbutton", toolkit: "gtk4",
    name: "Back", sizeModeX: "hug", sizeModeY: "fixed", grow: 0, widthPercent: 100, heightPercent: 100,
    minW: 0, maxW: 0, minH: 0, maxH: 0, colSpan: 1, rowSpan: 1, hideBelow: 0, showBelow: 600,
    x: titlebar.x + 8, y: titlebar.y + 5, w: 72, h: 34, radius: 8, fixed: false, z: 49,
    opacity: 100, margin: 0, padding: 0, fill: "#e7eaee", stroke: "#c9ced6", strokeWidth: 1,
    text: "← Back", fontSize: 14, textColor: "#3d3846", alignH: "center", alignV: "middle", textOverflow: "ellipsis"
  });
}
const back = doc.shapes.find((shape) => shape.parent === titlebar.id && shape.name === "Back");
Object.assign(back, {
  w: 36, h: 34, sizeModeX: "fixed", sizeModeY: "fixed", text: "<", textOverflow: "clip",
  padding: { t: 6, r: 6, b: 6, l: 6 }
});
delete back.interactionEnabled;
delete back.toggleTarget;
const descendants = new Set([regularRoot.id]);
let changed = true;
while (changed) {
  changed = false;
  for (const shape of doc.shapes) {
    if (shape.parent && descendants.has(shape.parent) && !descendants.has(shape.id)) {
      descendants.add(shape.id); changed = true;
    }
  }
}
const source = doc.shapes.filter((shape) => descendants.has(shape.id));
const ids = new Map(source.map((shape) => [shape.id, `compact_${shape.id}`]));
const compact = source.map((shape) => {
  const clone = JSON.parse(JSON.stringify(shape));
  clone.id = ids.get(shape.id);
  clone.parent = shape.parent ? ids.get(shape.parent) : null;
  clone.variantOf = regularRoot.id;
  clone.variantLabel = "Compact";
  if (shape === regularRoot) {
    clone.name = "AppLocker Settings Compact";
    clone.text = "AppLocker settings";
    clone.w = 520;
    clone.h = 700;
  }
  return clone;
});
doc.shapes.push(...compact);
doc.count = doc.shapes.length;
fs.writeFileSync(target, JSON.stringify(doc, null, 2) + "\n");
console.log(`Migrated ${target}: ${source.length} regular + ${compact.length} compact shapes`);
