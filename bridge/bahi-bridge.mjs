#!/usr/bin/env node
/**
 * Bahi Tally bridge agent.
 *
 * Runs on the computer that hosts TallyPrime. It polls Bahi for signed
 * commands, pushes voucher XML to Tally's HTTP gateway, and acknowledges the
 * results. Nothing is posted twice: every command carries an idempotency key,
 * the narration carries [BAHI:<key>], and Tally is checked for that narration
 * before a create is attempted.
 *
 * Environment:
 *   BAHI_BASE_URL         https://your-bahi-host        (required)
 *   BAHI_BRIDGE_TOKEN     token created in Bahi settings (required)
 *   TALLY_URL             http://localhost:9000          (Tally HTTP gateway)
 *   BAHI_COMPANY          optional override for the Tally company name
 *   BRIDGE_SIGNING_SECRET optional; when set, poll responses are verified
 *   POLL_INTERVAL_MS      default 3000
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const BASE = (process.env.BAHI_BASE_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.BAHI_BRIDGE_TOKEN ?? "";
const TALLY = (process.env.TALLY_URL ?? "http://localhost:9000").replace(/\/+$/, "");
const SIGNING_SECRET = process.env.BRIDGE_SIGNING_SECRET ?? "";
const POLL_MS = Math.max(1000, Number(process.env.POLL_INTERVAL_MS ?? 3000));
const VERSION = "bahi-bridge/1.0.0";

if (!BASE || !TOKEN) {
  console.error("Set BAHI_BASE_URL and BAHI_BRIDGE_TOKEN before starting the agent.");
  process.exit(1);
}

const headers = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  "user-agent": VERSION,
};

let company = process.env.BAHI_COMPANY ?? "";
const pendingAcks = new Map();
let lastError = null;

const log = (...args) => console.log(new Date().toISOString(), ...args);

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function tallyRequest(xml, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(TALLY, {
      method: "POST",
      headers: { "content-type": "text/xml; charset=utf-8" },
      body: xml,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Tally returned HTTP ${response.status}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function tallyErrors(body) {
  if (/<LINEERROR>/i.test(body)) {
    const first =
      body.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i)?.[1] ?? "Tally rejected the XML.";
    return first
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  }
  if (/<EXCEPTIONS>\s*[1-9]/i.test(body)) return "Tally reported exceptions.";
  return null;
}

function voucherXml(voucher, companyName, action = "Create", voucherNumber = "") {
  const entries = (voucher.entries ?? [])
    .map(
      (entry) => `
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${xmlEscape(entry.ledger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${entry.direction === "debit" ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
        <AMOUNT>${(entry.direction === "debit" ? entry.amount : -entry.amount).toFixed(2)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`,
    )
    .join("");
  const inventory = (voucher.inventory ?? [])
    .map(
      (line) => `
      <INVENTORYALLOCATIONS.LIST>
        <STOCKITEMNAME>${xmlEscape(line.item)}</STOCKITEMNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <RATE>${Number(line.rate).toFixed(2)}</RATE>
        <AMOUNT>${Number(line.amount).toFixed(2)}</AMOUNT>
        <ACTUALQTY>${line.quantity} ${xmlEscape(line.unit || "Nos")}</ACTUALQTY>
        <BILLEDQTY>${line.quantity} ${xmlEscape(line.unit || "Nos")}</BILLEDQTY>
        ${line.hsn ? `<HSNCODE>${xmlEscape(line.hsn)}</HSNCODE>` : ""}
      </INVENTORYALLOCATIONS.LIST>`,
    )
    .join("");
  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${xmlEscape(voucher.voucherType)}" ACTION="${action}" OBJVIEW="Accounting Voucher View">
            ${voucherNumber ? `<VOUCHERNUMBER>${xmlEscape(voucherNumber)}</VOUCHERNUMBER>` : ""}
            <DATE>${voucher.date}</DATE>
            <NARRATION>${xmlEscape(voucher.narration)}</NARRATION>
            <VOUCHERTYPENAME>${xmlEscape(voucher.voucherType)}</VOUCHERTYPENAME>
            <PARTYLEDGERNAME>${xmlEscape(voucher.party)}</PARTYLEDGERNAME>
            ${voucher.partyGstin ? `<PARTYGSTIN>${xmlEscape(voucher.partyGstin)}</PARTYGSTIN>` : ""}
            ${voucher.reference ? `<REFERENCE>${xmlEscape(voucher.reference)}</REFERENCE>` : ""}
            <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
            ${action === "Create" && voucher.isOptional ? "<ISOPTIONAL>Yes</ISOPTIONAL>" : ""}
            ${entries}${inventory}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

function collectionXml(type, companyName, fields, filterName = "", filterExpr = "") {
  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA>
    <REQUESTDESC>
      <REPORTNAME>List of Accounts</REPORTNAME>
      <STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
      <TDL><TDLMESSAGE>
        <COLLECTION NAME="BahisList" ISMODIFY="No">
          <TYPE>${type}</TYPE>
          ${filterName ? `<FILTER>${filterName}</FILTER>` : ""}
          ${fields.map((field) => `<NATIVEMETHOD>${field}</NATIVEMETHOD>`).join("")}
        </COLLECTION>
        ${filterName ? `<SYSTEM TYPE="Formulae" NAME="${filterName}">${filterExpr}</SYSTEM>` : ""}
      </TDLMESSAGE></TDL>
    </REQUESTDESC>
  </EXPORTDATA></BODY>
</ENVELOPE>`;
}

function attr(block, name) {
  const match = block.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match?.[1] ?? null;
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  return match?.[1]?.trim() ?? null;
}

function parseCollection(body, tagName) {
  const blocks = body.match(new RegExp(`<${tagName}\\b[\\s\\S]*?</${tagName}>`, "gi")) ?? [];
  return blocks.map((block) => ({
    name: attr(block, "NAME") ?? tag(block, "NAME") ?? "",
    parent: tag(block, "PARENT") ?? tag(block, "PARENTNAME"),
    gstin: tag(block, "PARTYGSTIN") ?? tag(block, "GSTIN"),
    block,
  }));
}

async function findVoucher(narration, companyName) {
  const filter = "BahisNarrationMatch";
  const xml = collectionXml(
    "Voucher",
    companyName,
    ["VoucherNumber", "Date", "Narration"],
    filter,
    `$Narration = "${xmlEscape(narration).replace(/"/g, '\\"')}"`,
  );
  try {
    const body = await tallyRequest(xml);
    const vouchers = parseCollection(body, "VOUCHER");
    const match = vouchers.find((entry) => (tag(entry.block, "NARRATION") ?? "") === narration);
    if (match) {
      return {
        voucherNumber: tag(match.block, "VOUCHERNUMBER") ?? match.name ?? null,
        date: tag(match.block, "DATE"),
      };
    }
  } catch (error) {
    log("voucher lookup failed:", error.message);
  }
  return null;
}

async function companyInfo(companyName) {
  try {
    const body = await tallyRequest(
      collectionXml("Company", companyName, ["Name", "GSTRegistrationNumber"]),
    );
    const companies = parseCollection(body, "COMPANY");
    const match = companies.find((entry) => entry.name === companyName) ?? companies[0];
    return {
      name: match?.name ?? companyName,
      gstin: match ? (tag(match.block, "GSTREGISTRATIONNUMBER") ?? null) : null,
      companies: companies.map((entry) => entry.name),
    };
  } catch (error) {
    return { name: companyName, gstin: null, companies: [], error: error.message };
  }
}

async function syncMasters(companyName) {
  const masters = [];
  try {
    const ledgerBody = await tallyRequest(
      collectionXml("Ledger", companyName, ["Name", "Parent", "PartyGSTIN"]),
    );
    for (const ledger of parseCollection(ledgerBody, "LEDGER")) {
      if (!ledger.name) continue;
      masters.push({
        kind: /debtor|creditor/i.test(ledger.parent ?? "") ? "vendor" : "ledger",
        name: ledger.name,
        ledger: ledger.name,
        ...(ledger.gstin ? { gstin: ledger.gstin } : {}),
      });
    }
  } catch (error) {
    log("ledger export failed:", error.message);
  }
  try {
    const itemBody = await tallyRequest(collectionXml("StockItem", companyName, ["Name"]));
    for (const item of parseCollection(itemBody, "STOCKITEM")) {
      if (item.name) masters.push({ kind: "item", name: item.name });
    }
  } catch (error) {
    log("stock item export failed:", error.message);
  }
  return { masters, count: masters.length, company: companyName };
}

async function postVoucher(voucher, companyName, draft) {
  const existing = await findVoucher(voucher.narration, companyName);
  if (existing?.voucherNumber) {
    return {
      created: false,
      duplicate: true,
      voucherNumber: existing.voucherNumber,
      note: "The voucher already existed in Tally; nothing was created.",
    };
  }
  const xml = voucherXml({ ...voucher, isOptional: draft }, companyName);
  const body = await tallyRequest(xml, 30000);
  const error = tallyErrors(body);
  if (error) throw new Error(error);
  const created = Number(body.match(/<CREATED>(\d+)<\/CREATED>/i)?.[1] ?? "1");
  log(`posted ${voucher.voucherType} ${voucher.date} (${voucher.party}) created=${created}`);
  const found = await findVoucher(voucher.narration, companyName);
  return {
    created: created > 0,
    voucherNumber: found?.voucherNumber ?? null,
    voucherDate: voucher.date,
    draft,
  };
}

async function cancelVoucher(voucherNumber, companyName, reason, voucherType) {
  const xml = voucherXml(
    {
      voucherType: voucherType || "Purchase",
      date: "",
      narration: reason ? `[BAHI:cancel] ${reason}` : "[BAHI:cancel]",
      party: "",
      entries: [],
    },
    companyName,
    "Cancel",
    voucherNumber,
  );
  const body = await tallyRequest(xml);
  const error = tallyErrors(body);
  if (error) throw new Error(error);
  return { voucherNumber, cancelled: true, body: body.slice(0, 500) };
}

async function handle(command) {
  if (command.type === "ping") {
    return { ok: true, at: new Date().toISOString(), version: VERSION };
  }
  if (command.type === "get_company_info") {
    return companyInfo(company);
  }
  if (command.type === "sync_masters") {
    return syncMasters(company);
  }
  if (command.type === "post_voucher" || command.type === "post_voucher_draft") {
    const voucher = command.payload?.voucher;
    if (!voucher) throw new Error("post_voucher arrived without a voucher payload.");
    const target = voucher.company || company;
    if (target) company = target;
    return postVoucher(voucher, target || company, command.type === "post_voucher_draft");
  }
  if (command.type === "get_voucher_status") {
    const found = await findVoucher(`[BAHI:${command.payload?.idempotencyKey ?? ""}]`, company);
    return { found: Boolean(found), ...(found ?? {}) };
  }
  if (command.type === "cancel_voucher") {
    return cancelVoucher(
      command.payload?.voucherNumber,
      company,
      command.payload?.reason,
      command.payload?.voucherType,
    );
  }
  throw new Error(`Unknown bridge command: ${command.type}`);
}

function verifySignature(payload) {
  if (!SIGNING_SECRET) return true;
  if (!payload.signed) return false;
  const expected = createHmac("sha256", SIGNING_SECRET)
    .update(JSON.stringify({ issuedAt: payload.issuedAt, commands: payload.commands }))
    .digest("hex");
  const given = String(payload.signature ?? "");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${path} returned ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

async function heartbeat() {
  try {
    const info = await post("/api/bridge/heartbeat", {
      version: VERSION,
      tallyUrl: TALLY,
      lastError,
    });
    if (info?.agent?.companyName) company = company || info.agent.companyName;
  } catch (error) {
    log("heartbeat failed:", error.message);
  }
}

async function flushAcks() {
  if (!pendingAcks.size) return;
  const results = [...pendingAcks.values()];
  try {
    await post("/api/bridge/ack", { results, version: VERSION, lastError });
    pendingAcks.clear();
    log(`acknowledged ${results.length} command(s)`);
  } catch (error) {
    log("ack failed, will retry:", error.message);
  }
}

async function tick() {
  await flushAcks();
  let payload;
  try {
    const response = await fetch(`${BASE}/api/bridge/poll`, {
      method: "POST",
      headers,
      body: JSON.stringify({ limit: 10, version: VERSION, tallyUrl: TALLY }),
    });
    if (!response.ok) {
      lastError = `poll returned ${response.status}`;
      return;
    }
    payload = await response.json();
  } catch (error) {
    lastError = `poll failed: ${error.message}`;
    return;
  }

  if (!verifySignature(payload)) {
    lastError = "Signature verification failed; commands were refused.";
    log(lastError);
    return;
  }
  lastError = null;
  if (!payload.commands?.length) return;

  for (const command of payload.commands) {
    try {
      const result = await handle(command);
      pendingAcks.set(command.id, { id: command.id, status: "acked", result });
      log(`acked ${command.type} ${command.id}`);
    } catch (error) {
      const message = error.message || "Command failed";
      pendingAcks.set(command.id, { id: command.id, status: "failed", error: message });
      lastError = message;
      log(`failed ${command.type} ${command.id}:`, message);
    }
  }
  await flushAcks();
}

log(`Bahi bridge agent ${VERSION}`);
log(`server ${BASE} · tally ${TALLY} · signature ${SIGNING_SECRET ? "on" : "off"}`);

await heartbeat();
setInterval(heartbeat, 60_000);
for (;;) {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
