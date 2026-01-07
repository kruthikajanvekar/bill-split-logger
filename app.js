const DB_NAME = "bill-split-logger";
const DB_VERSION = 1;
const STORE_NAME = "bills";

const SUPABASE_URL = "https://neqsrjgpkyemogehdrkx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_koZIfYpQQcb17nQ2lxyNxw_izsriw2u";
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const STORAGE_BUCKET = "bill-photos";
const SIGNED_URL_TTL = 60 * 60;
const signedUrlCache = new Map();

const form = document.getElementById("bill-form");
const totalInput = document.getElementById("total");
const createdAtInput = document.getElementById("created-at");
const paidByInput = document.getElementById("paid-by");
const notesInput = document.getElementById("notes");
const photosInput = document.getElementById("photos");
const photoPreview = document.getElementById("photo-preview");
const photoPreviewRow = document.getElementById("photo-preview-row");
const photoCount = document.getElementById("photo-count");
const clearPhotosBtn = document.getElementById("clear-photos");
const itemsList = document.getElementById("items-list");
const amountSummary = document.getElementById("amount-summary");
const aiToggle = document.getElementById("ai-toggle");
const manualToggle = document.getElementById("manual-toggle");
const splitResults = document.getElementById("split-results");
const runSplitBtn = document.getElementById("run-split");
const splitStatus = document.getElementById("split-status");
const splitsList = document.getElementById("splits-list");
const addSplitBtn = document.getElementById("add-split");
const splitSummary = document.getElementById("split-summary");
const splitExplanation = document.getElementById("split-explanation");
const splitExplanationText = document.getElementById("split-explanation-text");
const splitPreview = document.getElementById("split-preview");
const splitPreviewList = document.getElementById("split-preview-list");
const openManualBtn = document.getElementById("open-manual");
const openAiKeyInput = document.getElementById("openai-key");
const saveKeyBtn = document.getElementById("save-key");
const clearKeyBtn = document.getElementById("clear-key");
const keyHint = document.getElementById("key-hint");
const splitBlock = document.querySelector(".split-block");
const aiStatusChip = document.getElementById("ai-status-chip");
const checkAiBtn = document.getElementById("check-ai");
const aiSettingsForm = document.getElementById("ai-settings-form");
const addItemBtn = document.getElementById("add-item");
const resetBtn = document.getElementById("reset-form");
const openList = document.getElementById("open-list");
const completedList = document.getElementById("completed-list");
const openCount = document.getElementById("open-count");
const completedCount = document.getElementById("completed-count");
const snackbar = document.getElementById("snackbar");
const snackbarText = document.getElementById("snackbar-text");
const undoAction = document.getElementById("undo-action");
const emailLoginInput = document.getElementById("email-login");
const emailSignInBtn = document.getElementById("email-sign-in");
const emailRow = document.getElementById("email-row");
const emailDivider = document.getElementById("email-divider");
const emailHint = document.getElementById("email-hint");
const peopleDatalist = document.getElementById("people-suggestions");
const authStatus = document.getElementById("auth-status");
const authEmail = document.getElementById("auth-email");
const lastSync = document.getElementById("last-sync");
const signInBtn = document.getElementById("sign-in");
const signOutBtn = document.getElementById("sign-out");
const syncNowBtn = document.getElementById("sync-now");
const syncStatusChip = document.getElementById("sync-status-chip");

let snackbarTimeout = null;
let undoPayload = null;
let previewUrls = [];
let currentUser = null;
let syncInFlight = null;
let isSyncing = false;
let editingBillId = null;
let editingBillPhotos = [];
let currentSplitDetails = null;
let aiServerReady = false;
let aiChecking = false;
let aiInFlight = false;

const PEOPLE_KEY = "billlog_recent_people";
const LAST_PAID_KEY = "billlog_last_paid_by";
const OPENAI_KEY = "billlog_openai_key";
const AI_PREF_KEY = "billlog_ai_enabled";

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

async function getAuthHeader() {
  if (!supabaseClient) return {};
  const { data } = await supabaseClient.auth.getSession();
  let token = data?.session?.access_token;
  if (!token && currentUser) {
    const refreshed = await supabaseClient.auth.refreshSession();
    token = refreshed.data?.session?.access_token || "";
  }
  return token
    ? {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      }
    : {};
}

async function invokeSplitBill(body) {
  const headers = await getAuthHeader();
  if (!headers.Authorization) {
    const error = new Error("Missing auth token");
    error.status = 401;
    throw error;
  }

  const openaiKey = loadOpenAiKey();
  const payload = openaiKey ? { ...body, openai_key: openaiKey } : body;
  const response = await fetch(`${SUPABASE_URL}/functions/v1/split-bill`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error || data?.message || "Edge function request failed";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return data;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore(mode, fn) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllBills() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function saveBill(bill) {
  return withStore("readwrite", (store) => store.put(bill));
}

async function updateBillStatus(id, status) {
  return withStore("readwrite", (store) => {
    const req = store.get(id);
    req.onsuccess = () => {
      const bill = req.result;
      if (!bill) return;
      bill.status = status;
      bill.updatedAt = new Date().toISOString();
      store.put(bill);
    };
  });
}

async function deleteBill(id) {
  return withStore("readwrite", (store) => store.delete(id));
}

async function getBill(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toInputValue(date) {
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function generateId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `bill-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sanitizeFilename(name) {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-");
}

function buildPhotoPath(userId, billId, photo) {
  const safeName = sanitizeFilename(photo.name || "photo.jpg");
  return `${userId}/${billId}/${Date.now()}-${safeName}`;
}

async function getSignedPhotoUrl(path) {
  const cached = signedUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient
    .storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);
  if (error) return null;
  const url = data?.signedUrl;
  if (url) {
    signedUrlCache.set(path, { url, expiresAt: Date.now() + (SIGNED_URL_TTL - 30) * 1000 });
  }
  return url || null;
}

function createItemRow(item = {}) {
  const safeItem = item || {};
  const row = document.createElement("div");
  row.className = "item-row";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Item";
  nameInput.value = safeItem.name || "";
  nameInput.name = "item-name";
  nameInput.setAttribute("aria-label", "Item name");

  const personInput = document.createElement("input");
  personInput.type = "text";
  personInput.placeholder = "Person";
  personInput.value = safeItem.person || "";
  personInput.setAttribute("list", "people-suggestions");
  personInput.name = "item-person";
  personInput.setAttribute("aria-label", "Person");

  const amountInput = document.createElement("input");
  amountInput.type = "number";
  amountInput.step = "0.01";
  amountInput.inputMode = "decimal";
  amountInput.placeholder = "Amount (opt)";
  amountInput.value = safeItem.amount ?? "";
  amountInput.name = "item-amount";
  amountInput.setAttribute("aria-label", "Item amount");

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.title = "Remove item";
  removeButton.textContent = "✕";

  row.append(nameInput, personInput, amountInput, removeButton);

  removeButton.addEventListener("click", () => {
    row.remove();
    updateAmountSummary();
  });

  return row;
}

function addItemRow(item, { focus = false } = {}) {
  const row = createItemRow(item);
  itemsList.appendChild(row);
  if (focus) {
    const firstInput = row.querySelector("input");
    if (firstInput) firstInput.focus();
  }
}

function createSplitRow(split = {}) {
  const safeSplit = split || {};
  const row = document.createElement("div");
  row.className = "split-row";

  const personInput = document.createElement("input");
  personInput.type = "text";
  personInput.placeholder = "Person";
  personInput.value = safeSplit.person || "";
  personInput.setAttribute("list", "people-suggestions");
  personInput.name = "split-person";
  personInput.setAttribute("aria-label", "Split person");

  const amountInput = document.createElement("input");
  amountInput.type = "number";
  amountInput.step = "0.01";
  amountInput.inputMode = "decimal";
  amountInput.placeholder = "Amount";
  amountInput.value = safeSplit.amount ?? "";
  amountInput.name = "split-amount";
  amountInput.setAttribute("aria-label", "Split amount");

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.title = "Remove split";
  removeButton.textContent = "✕";
  removeButton.addEventListener("click", () => {
    row.remove();
    updateSplitSummary();
  });

  row.append(personInput, amountInput, removeButton);
  return row;
}

function addSplitRow(split, { focus = false } = {}) {
  const row = createSplitRow(split);
  splitsList.appendChild(row);
  if (focus) {
    const firstInput = row.querySelector("input");
    if (firstInput) firstInput.focus();
  }
}

function collectItems() {
  return Array.from(itemsList.querySelectorAll(".item-row")).map((row) => {
    const inputs = row.querySelectorAll("input");
    const name = inputs[0].value.trim();
    const person = inputs[1].value.trim();
    const amountRaw = inputs[2].value.trim();
    const amount = amountRaw ? Number.parseFloat(amountRaw) : null;
    if (!name && !person && !amountRaw) return null;
    return { name, person, amount };
  }).filter(Boolean);
}

function collectSplits() {
  return Array.from(splitsList.querySelectorAll(".split-row")).map((row) => {
    const inputs = row.querySelectorAll("input");
    const person = inputs[0].value.trim();
    const amountRaw = inputs[1].value.trim();
    const amount = amountRaw ? Number.parseFloat(amountRaw) : null;
    if (!person && !amountRaw) return null;
    return { person, amount };
  }).filter(Boolean);
}

function updateAmountSummary() {
  const items = collectItems();
  const knownAmounts = items.map((item) => item.amount).filter((amount) => amount != null);
  if (!knownAmounts.length) {
    amountSummary.classList.add("hidden");
    amountSummary.textContent = "";
    return;
  }
  const sum = knownAmounts.reduce((acc, val) => acc + val, 0);
  const totalValue = Number.parseFloat(totalInput.value);
  const parts = [`Known items: ${moneyFormatter.format(sum)}`];
  if (!Number.isNaN(totalValue)) {
    const remaining = totalValue - sum;
    parts.push(`Remaining: ${moneyFormatter.format(remaining)}`);
  }
  amountSummary.textContent = parts.join(" • ");
  amountSummary.classList.remove("hidden");
}

function updateSplitSummary() {
  const splits = collectSplits();
  const amounts = splits.map((split) => split.amount).filter((amount) => amount != null);
  if (!amounts.length) {
    splitSummary.classList.add("hidden");
    splitSummary.textContent = "";
    updateSplitPreview();
    return;
  }
  const sum = amounts.reduce((acc, val) => acc + val, 0);
  splitSummary.textContent = `Split total: ${moneyFormatter.format(sum)}`;
  splitSummary.classList.remove("hidden");
  updateSplitPreview();
}

function updateSplitPreview() {
  const splits = collectSplits();
  if (manualToggle.checked || !splits.length) {
    splitPreview.classList.add("hidden");
    splitPreviewList.innerHTML = "";
    return;
  }
  splitPreview.classList.remove("hidden");
  splitPreviewList.innerHTML = "";
  const max = 3;
  splits.slice(0, max).forEach((split) => {
    const row = document.createElement("div");
    row.className = "bill-item";
    const name = document.createElement("strong");
    name.textContent = split.person || "Person";
    const amount = document.createElement("span");
    amount.textContent = split.amount != null ? moneyFormatter.format(split.amount) : "";
    row.appendChild(name);
    row.appendChild(amount);
    splitPreviewList.appendChild(row);
  });
  if (splits.length > max) {
    const more = document.createElement("div");
    more.className = "bill-item";
    more.innerHTML = `<span>+${splits.length - max} more people</span>`;
    splitPreviewList.appendChild(more);
  }
}

async function readPhotos() {
  const files = Array.from(photosInput.files || []);
  return files.map((file) => ({
    name: file.name,
    type: file.type,
    size: file.size,
    blob: file,
  }));
}

function clearForm() {
  form.reset();
  createdAtInput.value = toInputValue(new Date());
  const lastPaid = localStorage.getItem(LAST_PAID_KEY) || "";
  paidByInput.value = lastPaid;
  itemsList.innerHTML = "";
  addItemRow();
  updatePhotoPreview();
  updateAmountSummary();
  splitsList.innerHTML = "";
  addSplitRow();
  splitExplanation.classList.add("hidden");
  splitExplanationText.textContent = "";
  splitStatus.textContent = "";
  splitSummary.classList.add("hidden");
  splitSummary.textContent = "";
  manualToggle.checked = false;
  splitResults.classList.add("hidden");
  editingBillId = null;
  editingBillPhotos = [];
  currentSplitDetails = null;
  form.querySelector(".actions .primary").textContent = "Save bill";
  updateAiVisibility();
}

function setSnackbar(text, actionLabel, action) {
  snackbarText.textContent = text;
  if (actionLabel && action) {
    undoAction.textContent = actionLabel;
    undoAction.onclick = action;
    undoAction.classList.remove("hidden");
  } else {
    undoAction.textContent = "";
    undoAction.onclick = null;
    undoAction.classList.add("hidden");
  }
  snackbar.classList.add("show");
  if (snackbarTimeout) clearTimeout(snackbarTimeout);
  snackbarTimeout = setTimeout(() => {
    snackbar.classList.remove("show");
  }, 4200);
}

function cleanupObjectUrls(container) {
  container.querySelectorAll("img[data-object-url]").forEach((img) => {
    URL.revokeObjectURL(img.dataset.objectUrl);
  });
}

function updatePhotoPreview() {
  previewUrls.forEach((url) => URL.revokeObjectURL(url));
  previewUrls = [];
  photoPreviewRow.innerHTML = "";
  const files = Array.from(photosInput.files || []);
  const existingPhotos = !files.length ? editingBillPhotos : [];
  const totalCount = files.length + existingPhotos.length;
  if (!totalCount) {
    photoPreview.classList.add("hidden");
    photoCount.textContent = "0 photos";
    return;
  }
  photoPreview.classList.remove("hidden");
  photoCount.textContent = `${totalCount} photo${totalCount === 1 ? "" : "s"}`;
  files.forEach((file) => {
    const url = URL.createObjectURL(file);
    previewUrls.push(url);
    const img = document.createElement("img");
    img.src = url;
    img.alt = file.name || "Bill photo";
    img.dataset.objectUrl = url;
    photoPreviewRow.appendChild(img);
  });
  existingPhotos.forEach((photo) => {
    const img = document.createElement("img");
    img.alt = photo.name || "Bill photo";
    if (photo.blob) {
      const url = URL.createObjectURL(photo.blob);
      previewUrls.push(url);
      img.src = url;
    } else if (photo.path && supabaseClient && currentUser) {
      getSignedPhotoUrl(photo.path).then((url) => {
        if (url) img.src = url;
      });
    }
    photoPreviewRow.appendChild(img);
  });
}

function loadRecentPeople() {
  try {
    const raw = localStorage.getItem(PEOPLE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecentPeople(list) {
  localStorage.setItem(PEOPLE_KEY, JSON.stringify(list));
}

function updatePeopleDatalist() {
  const people = loadRecentPeople();
  peopleDatalist.innerHTML = "";
  people.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    peopleDatalist.appendChild(option);
  });
}

function rememberPeople(names) {
  const cleaned = names.map((name) => name.trim()).filter(Boolean);
  if (!cleaned.length) return;
  const existing = loadRecentPeople();
  const merged = [...cleaned, ...existing];
  const unique = [];
  merged.forEach((name) => {
    if (!unique.includes(name)) unique.push(name);
  });
  saveRecentPeople(unique.slice(0, 12));
  updatePeopleDatalist();
}

function loadOpenAiKey() {
  return localStorage.getItem(OPENAI_KEY) || "";
}

function saveOpenAiKey(value) {
  if (!value) return;
  localStorage.setItem(OPENAI_KEY, value);
  updateKeyHint();
}

function clearOpenAiKey() {
  localStorage.removeItem(OPENAI_KEY);
  updateKeyHint();
}

function updateKeyHint() {
  const key = loadOpenAiKey();
  if (!currentUser) {
    keyHint.textContent = key
      ? "Key saved locally. Sign in to use it."
      : "Sign in to enable AI splitting.";
    return;
  }
  if (aiChecking) {
    keyHint.textContent = "Checking AI server…";
    return;
  }
  if (key) {
    const last4 = key.slice(-4);
    keyHint.textContent = `Using your key (ends with ${last4}).`;
    return;
  }
  keyHint.textContent = aiServerReady
    ? "AI is configured on the server."
    : "AI server is not configured yet.";
}

function setSplitStatus(message) {
  splitStatus.textContent = message;
}

function setManualVisible(visible) {
  manualToggle.checked = visible;
  splitResults.classList.toggle("hidden", !visible);
  updateSplitPreview();
}

function updateAiVisibility() {
  const localKey = loadOpenAiKey();
  const serverReady = aiServerReady && currentUser;
  const aiReady = serverReady || (currentUser && !!localKey);
  const preferred = localStorage.getItem(AI_PREF_KEY);
  if (preferred === null) {
    aiToggle.checked = true;
  } else {
    aiToggle.checked = preferred === "true";
  }

  aiToggle.disabled = !aiReady;
  const enabled = aiReady && aiToggle.checked;
  splitBlock.classList.toggle("hidden", !enabled);
  runSplitBtn.disabled = !enabled || aiInFlight;

  if (!aiReady) {
    if (!currentUser) {
      setSplitStatus("Sign in to enable AI.");
    } else {
      setSplitStatus("AI needs setup on the server or your key.");
    }
    aiStatusChip.textContent = aiChecking ? "Checking…" : "AI not configured";
    aiStatusChip.classList.add("warn");
    aiStatusChip.classList.remove("good");
  } else {
    aiStatusChip.textContent = localKey ? "Using your key" : "Server AI ready";
    aiStatusChip.classList.add("good");
    aiStatusChip.classList.remove("warn");
    if (!enabled) {
      setSplitStatus("AI split is off.");
    } else {
      setSplitStatus("AI will run after save. Use “Split now” to preview.");
    }
  }
}

async function checkAiServer() {
  if (!supabaseClient || !currentUser) {
    aiServerReady = false;
    updateKeyHint();
    updateAiVisibility();
    return;
  }
  aiChecking = true;
  updateAiVisibility();
  try {
    const openaiKey = loadOpenAiKey();
    const data = await invokeSplitBill(openaiKey ? { ping: true, openai_key: openaiKey } : { ping: true });
    aiServerReady = Boolean(data?.configured ?? true);
  } catch (error) {
    aiServerReady = false;
    if (error?.status === 401) {
      setSplitStatus("Sign in again to enable AI.");
    }
  } finally {
    aiChecking = false;
    updateKeyHint();
    updateAiVisibility();
  }
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || "";
      const base64 = result.toString().split(",")[1];
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function getAiImageInputs() {
  const files = Array.from(photosInput.files || []);
  if (files.length) return files;
  if (editingBillPhotos.length) {
    const blobs = editingBillPhotos.map((photo) => photo.blob).filter(Boolean);
    if (blobs.length) return blobs;
    const remotePaths = editingBillPhotos.map((photo) => photo.path).filter(Boolean);
    if (remotePaths.length && supabaseClient && currentUser) {
      const fetched = [];
      for (const path of remotePaths) {
        const url = await getSignedPhotoUrl(path);
        if (!url) continue;
        const response = await fetch(url);
        if (!response.ok) continue;
        const blob = await response.blob();
        fetched.push(new File([blob], "receipt.jpg", { type: blob.type || "image/jpeg" }));
      }
      return fetched;
    }
  }
  return [];
}

function buildSplitPrompt({ instructions, total, items }) {
  const lines = [];
  lines.push("You are splitting a restaurant bill among people.");
  lines.push("Use the receipt images and the user's notes to assign items.");
  lines.push("Split taxes, tips, and extra fees proportionally to each person's pre-tax subtotal unless stated otherwise.");
  lines.push("Return amounts per person and show the math clearly.");
  if (total) lines.push(`User-entered total: ${total}.`);
  if (items.length) {
    lines.push("User-noted items:");
    items.forEach((item) => {
      const parts = [item.name, item.person, item.amount != null ? moneyFormatter.format(item.amount) : null]
        .filter(Boolean)
        .join(" — ");
      lines.push(`- ${parts}`);
    });
  }
  if (instructions) {
    lines.push("User notes:");
    lines.push(instructions);
  }
  return lines.join("\n");
}

function extractStructuredOutput(data) {
  const output = data?.output?.[0]?.content?.[0];
  if (!output) return null;
  if (output.type === "output_json") return output.json;
  if (output.type === "output_text") {
    try {
      return JSON.parse(output.text);
    } catch {
      return null;
    }
  }
  return null;
}

function applySplitResult(result) {
  if (!result) return;
  if (!totalInput.value && result.total) {
    totalInput.value = result.total;
  }
  splitsList.innerHTML = "";
  (result.splits || []).filter(Boolean).forEach((split) => {
    addSplitRow({ person: split.person, amount: split.amount });
  });
  if (!result.splits?.length) addSplitRow();
  setManualVisible(manualToggle.checked);
  updateSplitSummary();

  const mathText = result.math || result.explanation || "";
  if (mathText) {
    splitExplanationText.textContent = mathText;
    splitExplanation.classList.remove("hidden");
  } else {
    splitExplanationText.textContent = "";
    splitExplanation.classList.add("hidden");
  }

  currentSplitDetails = {
    currency: result.currency || "USD",
    subtotal: result.subtotal ?? null,
    tax: result.tax ?? null,
    tip: result.tip ?? null,
    fees: result.fees ?? null,
    lineItems: result.line_items || [],
    math: mathText,
    notes: result.notes || "",
  };
}

function buildSplitSchema() {
  return {
    type: "json_schema",
    json_schema: {
      name: "bill_split",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          currency: { type: "string" },
          total: { type: "number" },
          subtotal: { type: "number" },
          tax: { type: "number" },
          tip: { type: "number" },
          fees: { type: "number" },
          line_items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                quantity: { type: "number" },
                price: { type: "number" },
                total: { type: "number" },
                assigned_to: { type: "array", items: { type: "string" } },
                split_rule: { type: "string" },
              },
              required: ["name", "total"],
            },
          },
          splits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                person: { type: "string" },
                amount: { type: "number" },
                items: { type: "array", items: { type: "string" } },
              },
              required: ["person", "amount"],
            },
          },
          math: { type: "string" },
          notes: { type: "string" },
        },
        required: ["total", "splits", "math"],
      },
    },
  };
}

async function requestSplit({ prompt, images }) {
  if (!supabaseClient) {
    throw new Error("AI server not available");
  }
  const localKey = loadOpenAiKey();
  if (!aiServerReady && !localKey) {
    throw new Error("AI server not available");
  }
  const data = await invokeSplitBill({ prompt, images });
  return data?.result || data;
}

async function runAutoSplit({ bill, silent = false, applyToForm = true } = {}) {
  if (!aiToggle.checked) {
    if (!silent) setSplitStatus("AI split is off.");
    return null;
  }
  if (!currentUser) {
    if (!silent) setSplitStatus("Sign in to use AI.");
    return null;
  }
  if (!aiServerReady && !loadOpenAiKey()) {
    if (!silent) setSplitStatus("AI is not ready yet. Try again after sign in.");
    return null;
  }

  const notes = bill?.notes ?? notesInput.value.trim();
  const items = bill?.items ?? collectItems();
  const totalValue = bill?.total ?? Number.parseFloat(totalInput.value);
  const images = bill?.photos || await getAiImageInputs();
  if (!images.length && !notes) {
    if (!silent) setSplitStatus("Add a receipt photo or notes first.");
    return null;
  }

  aiInFlight = true;
  updateAiVisibility();
  if (!silent) setSplitStatus("Analyzing receipt…");

  const prompt = buildSplitPrompt({
    instructions: notes,
    total: totalValue ? moneyFormatter.format(totalValue) : null,
    items,
  });

  const imageInputs = [];
  const maxImages = 3;
  for (const file of images.slice(0, maxImages)) {
    if (file.base64) {
      imageInputs.push(file);
      continue;
    }
    if (file.blob) {
      const base64 = await fileToBase64(file.blob);
      imageInputs.push({ base64, type: file.blob.type || "image/jpeg" });
      continue;
    }
    const base64 = await fileToBase64(file);
    imageInputs.push({ base64, type: file.type || "image/jpeg" });
  }

  try {
    const result = await requestSplit({ prompt, images: imageInputs });
    if (!result) throw new Error("No result");
    if (applyToForm) {
      applySplitResult(result);
      setSplitStatus("Split ready. You can edit the amounts before saving.");
    }
    return result;
  } catch (error) {
    if (!silent) setSplitStatus("Auto-split failed. Check settings and try again.");
    return null;
  } finally {
    aiInFlight = false;
    updateAiVisibility();
  }
}

function stripPhotoForSync(photo) {
  return {
    path: photo.path || null,
    name: photo.name || "",
    type: photo.type || "",
    size: photo.size || (photo.blob ? photo.blob.size : null),
  };
}

function mergePhotoLists(remotePhotos, localPhotos) {
  const localByPath = new Map(
    (localPhotos || []).filter((photo) => photo.path).map((photo) => [photo.path, photo])
  );
  return (remotePhotos || []).map((photo) => {
    if (photo?.path && localByPath.has(photo.path)) {
      return { ...photo, ...localByPath.get(photo.path) };
    }
    return photo;
  });
}

async function ensurePhotoUploads(bill) {
  if (!supabaseClient || !currentUser) return bill;
  const photos = bill.photos || [];
  let changed = false;
  const updatedPhotos = [];

  for (const photo of photos) {
    if (photo.path || !photo.blob) {
      updatedPhotos.push(photo);
      continue;
    }
    const path = buildPhotoPath(currentUser.id, bill.id, photo);
    const { error } = await supabaseClient
      .storage
      .from(STORAGE_BUCKET)
      .upload(path, photo.blob, { contentType: photo.type || undefined, upsert: false });
    if (error) {
      updatedPhotos.push(photo);
      continue;
    }
    changed = true;
    updatedPhotos.push({ ...photo, path, size: photo.blob.size });
  }

  if (changed) {
    const updatedAt = new Date().toISOString();
    const updatedBill = { ...bill, photos: updatedPhotos, updatedAt };
    await saveBill(updatedBill);
    return updatedBill;
  }

  return { ...bill, photos: updatedPhotos };
}

async function deleteRemotePhotos(photos) {
  if (!supabaseClient || !currentUser) return;
  const paths = (photos || []).map((photo) => photo.path).filter(Boolean);
  if (!paths.length) return;
  await supabaseClient.storage.from(STORAGE_BUCKET).remove(paths);
  paths.forEach((path) => signedUrlCache.delete(path));
}

async function deleteRemoteBill(bill) {
  if (!supabaseClient || !currentUser) return;
  await deleteRemotePhotos(bill.photos || []);
  await supabaseClient.from("bills").delete().eq("id", bill.id);
}

function getSyncKey(userId) {
  return `billlog_last_sync_${userId}`;
}

function formatSyncTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function updateAuthUI() {
  if (!supabaseClient) {
    authStatus.textContent = "Cloud sync unavailable";
    authEmail.textContent = "";
    lastSync.textContent = "";
    signInBtn.classList.add("hidden");
    signOutBtn.classList.add("hidden");
    syncNowBtn.classList.add("hidden");
    emailRow?.classList.add("hidden");
    emailDivider?.classList.add("hidden");
    emailHint?.classList.add("hidden");
    syncStatusChip.textContent = "Offline";
    syncStatusChip.classList.add("warn");
    syncStatusChip.classList.remove("good");
    return;
  }

  if (isSyncing) {
    syncStatusChip.textContent = "Syncing";
    syncStatusChip.classList.add("warn");
    syncStatusChip.classList.remove("good");
  } else if (currentUser) {
    syncStatusChip.textContent = "Cloud on";
    syncStatusChip.classList.add("good");
    syncStatusChip.classList.remove("warn");
  } else {
    syncStatusChip.textContent = "Offline";
    syncStatusChip.classList.add("warn");
    syncStatusChip.classList.remove("good");
  }

  if (currentUser) {
    authStatus.textContent = "Signed in";
    authEmail.textContent = currentUser.email || "";
    signInBtn.classList.add("hidden");
    signOutBtn.classList.remove("hidden");
    syncNowBtn.classList.remove("hidden");
    emailRow?.classList.add("hidden");
    emailDivider?.classList.add("hidden");
    emailHint?.classList.add("hidden");
    if (emailLoginInput) emailLoginInput.value = "";
    const last = localStorage.getItem(getSyncKey(currentUser.id));
    lastSync.textContent = last ? `Last sync ${formatSyncTime(last)}` : "Not synced yet";
  } else {
    authStatus.textContent = "Not signed in";
    authEmail.textContent = "";
    lastSync.textContent = "";
    signInBtn.classList.remove("hidden");
    signOutBtn.classList.add("hidden");
    syncNowBtn.classList.add("hidden");
    emailRow?.classList.remove("hidden");
    emailDivider?.classList.remove("hidden");
    emailHint?.classList.remove("hidden");
  }
}

function mapBillToRow(bill, userId) {
  return {
    id: bill.id,
    user_id: userId,
    status: bill.status,
    total: bill.total,
    paid_by: bill.paidBy || null,
    notes: bill.notes || null,
    items: bill.items || [],
    splits: bill.splits || [],
    split_math: bill.splitMath || null,
    split_details: bill.splitDetails || null,
    ai_status: bill.aiStatus || null,
    photos: (bill.photos || [])
      .filter((photo) => photo.path)
      .map(stripPhotoForSync),
    created_at: bill.createdAt,
    updated_at: bill.updatedAt || bill.createdAt,
  };
}

function rowToBill(row, existing = {}) {
  const remotePhotos = Array.isArray(row.photos) ? row.photos : [];
  const mergedPhotos = mergePhotoLists(remotePhotos, existing.photos || []);
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    total: Number.parseFloat(row.total ?? 0),
    paidBy: row.paid_by || "",
    notes: row.notes || "",
    items: Array.isArray(row.items) ? row.items : [],
    splits: Array.isArray(row.splits) ? row.splits : [],
    splitMath: row.split_math || "",
    splitDetails: row.split_details || null,
    aiStatus: row.ai_status || null,
    photos: mergedPhotos,
    syncedAt: existing.syncedAt || null,
  };
}

async function syncAll() {
  if (!supabaseClient || !currentUser) return;
  if (!navigator.onLine) {
    setSnackbar("You're offline. Sync will resume when back online.", null, null);
    return;
  }
  isSyncing = true;
  updateAuthUI();

  const { data: remoteRows, error } = await supabaseClient
    .from("bills")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    isSyncing = false;
    updateAuthUI();
    setSnackbar("Sync failed. Check connection.", null, null);
    return;
  }

  const localBills = await getAllBills();
  const remoteMap = new Map((remoteRows || []).map((row) => [row.id, row]));
  const localMap = new Map(localBills.map((bill) => [bill.id, bill]));
  const toUpsert = [];
  const toDeleteRemote = [];
  const toDeleteLocalIds = new Set();

  for (const row of remoteRows || []) {
    const local = localMap.get(row.id);
    const remoteUpdated = new Date(row.updated_at || row.created_at).getTime();

    if (row.status === "deleted") {
      if (local) toDeleteLocalIds.add(local.id);
      toDeleteRemote.push(rowToBill(row, local || {}));
      continue;
    }

    if (!local) {
      await saveBill(rowToBill(row));
      continue;
    }

    const localUpdated = new Date(local.updatedAt || local.createdAt).getTime();
    if (local.status === "deleted") {
      if (localUpdated >= remoteUpdated) {
        toDeleteRemote.push(local);
        toDeleteLocalIds.add(local.id);
      } else {
        await saveBill(rowToBill(row, local));
      }
      continue;
    }

    if (remoteUpdated > localUpdated) {
      await saveBill(rowToBill(row, local));
    } else if (localUpdated > remoteUpdated) {
      toUpsert.push(local);
    }
  }

  for (const local of localBills) {
    if (!remoteMap.has(local.id)) {
      if (local.status === "deleted") {
        toDeleteLocalIds.add(local.id);
      } else {
        toUpsert.push(local);
      }
    }
  }

  if (toDeleteRemote.length) {
    for (const bill of toDeleteRemote) {
      await deleteRemoteBill(bill);
    }
  }

  if (toDeleteLocalIds.size) {
    await Promise.all([...toDeleteLocalIds].map((id) => deleteBill(id)));
  }

  if (toUpsert.length) {
    const rows = [];
    for (const bill of toUpsert) {
      const updatedBill = await ensurePhotoUploads(bill);
      rows.push(mapBillToRow(updatedBill, currentUser.id));
    }
    const { error: upsertError } = await supabaseClient
      .from("bills")
      .upsert(rows, { onConflict: "id" });
    if (upsertError) {
      isSyncing = false;
      updateAuthUI();
      setSnackbar("Sync failed. Try again.", null, null);
      return;
    }
  }

  const syncTime = new Date().toISOString();
  localStorage.setItem(getSyncKey(currentUser.id), syncTime);
  const syncedBills = await getAllBills();
  await Promise.all(
    syncedBills
      .filter((bill) => bill.status !== "deleted")
      .map((bill) => saveBill({ ...bill, syncedAt: syncTime }))
  );

  isSyncing = false;
  updateAuthUI();
  setSnackbar("Sync complete.", null, null);
  await renderLists();
}

async function runSync() {
  if (!supabaseClient || !currentUser) return;
  if (syncInFlight) return syncInFlight;
  syncInFlight = syncAll().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function processPendingSplits() {
  if (aiInFlight) return;
  const aiReady = (aiServerReady || !!loadOpenAiKey()) && currentUser;
  if (!aiReady || !aiToggle.checked) return;

  const bills = await getAllBills();
  const pending = bills.filter((bill) => bill.aiStatus === "pending");
  if (!pending.length) return;

  for (const bill of pending.slice(0, 2)) {
    if (bill.splits?.length) continue;
    const latest = await getBill(bill.id);
    if (!latest || latest.aiStatus !== "pending") continue;
    const result = await runAutoSplit({ bill: latest, silent: true, applyToForm: false });
    if (result) {
      const updatedBill = {
        ...latest,
        splits: result.splits || [],
        splitMath: result.math || "",
        splitDetails: result,
        aiStatus: "done",
        updatedAt: new Date().toISOString(),
      };
      await saveBill(updatedBill);
      await runSync();
    } else {
      const failedBill = { ...latest, aiStatus: "failed", updatedAt: new Date().toISOString() };
      await saveBill(failedBill);
    }
  }
  await renderLists();
}

async function initAuth() {
  if (!supabaseClient) {
    updateAuthUI();
    return;
  }

  const { data } = await supabaseClient.auth.getSession();
  currentUser = data?.session?.user ?? null;
  updateAuthUI();
  if (currentUser) {
    checkAiServer();
    runSync().then(processPendingSplits);
  }

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user ?? null;
    updateAuthUI();
    if (currentUser) {
      checkAiServer();
      runSync().then(processPendingSplits);
    }
  });

  signInBtn.addEventListener("click", async () => {
    const origin = window.location.origin;
    const options = origin.startsWith("http") ? { redirectTo: origin } : undefined;
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options,
    });
    if (error) setSnackbar("Sign-in failed.", null, null);
  });

  emailSignInBtn?.addEventListener("click", async () => {
    const email = emailLoginInput?.value.trim() || "";
    if (!email) {
      setSnackbar("Enter an email to get a sign-in link.", null, null);
      return;
    }
    const origin = window.location.origin;
    const options = origin.startsWith("http") ? { emailRedirectTo: origin } : undefined;
    const { error } = await supabaseClient.auth.signInWithOtp({
      email,
      options,
    });
    if (error) {
      setSnackbar("Email sign-in failed.", null, null);
    } else {
      setSnackbar("Check your inbox for a magic link.", null, null);
      emailLoginInput.value = "";
    }
  });

  signOutBtn.addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    currentUser = null;
    updateAuthUI();
  });

  syncNowBtn.addEventListener("click", () => runSync());
}
function createBillCard(bill, isOpen) {
  const card = document.createElement("div");
  card.className = "bill-card";
  card.dataset.id = bill.id;

  const swipeBg = document.createElement("div");
  swipeBg.className = "swipe-bg";
  swipeBg.textContent = isOpen ? "Swipe to complete" : "Completed";

  const content = document.createElement("div");
  content.className = "bill-content";
  content.innerHTML = `
    <div class="bill-top">
      <div>
        <div class="bill-total">${moneyFormatter.format(bill.total || 0)}</div>
        <div class="bill-date">${formatDateTime(bill.createdAt)}</div>
      </div>
      <div class="bill-meta-right"></div>
    </div>
    <div class="bill-meta"></div>
    <div class="bill-items"></div>
    <div class="bill-splits"></div>
    <details class="split-explanation hidden">
      <summary>Show math</summary>
      <pre></pre>
    </details>
    <div class="thumb-row"></div>
    <div class="bill-actions"></div>
  `;

  const meta = content.querySelector(".bill-meta");
  if (bill.paidBy) {
    const line = document.createElement("div");
    line.className = "bill-notes";
    line.textContent = `Paid by ${bill.paidBy}`;
    meta.appendChild(line);
  }
  if (bill.notes) {
    const line = document.createElement("div");
    line.className = "bill-notes";
    line.textContent = bill.notes;
    meta.appendChild(line);
  }

  const itemsWrap = content.querySelector(".bill-items");
  const items = bill.items || [];
  const metaRight = content.querySelector(".bill-meta-right");
  if (items.length) {
    const count = document.createElement("div");
    count.className = "bill-date";
    count.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
    metaRight.appendChild(count);
  }
  const maxItems = 3;
  items.slice(0, maxItems).forEach((item) => {
    const line = document.createElement("div");
    line.className = "bill-item";
    const amountText = item.amount != null ? moneyFormatter.format(item.amount) : "";
    const title = document.createElement("strong");
    title.textContent = item.name || "Item";
    const metaSpan = document.createElement("span");
    metaSpan.textContent = [item.person, amountText].filter(Boolean).join(" • ");
    line.appendChild(title);
    line.appendChild(metaSpan);
    itemsWrap.appendChild(line);
  });
  if (items.length > maxItems) {
    const line = document.createElement("div");
    line.className = "bill-item";
    line.innerHTML = `<span>+${items.length - maxItems} more items</span>`;
    itemsWrap.appendChild(line);
  }

  const splitsWrap = content.querySelector(".bill-splits");
  const splits = bill.splits || [];
  if (splits.length) {
    splitsWrap.className = "bill-items";
    splits.slice(0, 4).forEach((split) => {
      const line = document.createElement("div");
      line.className = "bill-item";
      const name = document.createElement("strong");
      name.textContent = split.person || "Person";
      const amount = document.createElement("span");
      amount.textContent = split.amount != null ? moneyFormatter.format(split.amount) : "";
      line.appendChild(name);
      line.appendChild(amount);
      splitsWrap.appendChild(line);
    });
    if (splits.length > 4) {
      const line = document.createElement("div");
      line.className = "bill-item";
      line.innerHTML = `<span>+${splits.length - 4} more splits</span>`;
      splitsWrap.appendChild(line);
    }
  } else if (bill.aiStatus === "pending") {
    const line = document.createElement("div");
    line.className = "bill-notes";
    line.textContent = "AI splitting in the background…";
    splitsWrap.appendChild(line);
  } else if (bill.aiStatus === "failed") {
    const line = document.createElement("div");
    line.className = "bill-notes";
    line.textContent = "AI split failed — open to retry.";
    splitsWrap.appendChild(line);
  }

  const math = bill.splitMath || "";
  const mathDetails = content.querySelector(".split-explanation");
  if (math) {
    mathDetails.classList.remove("hidden");
    mathDetails.querySelector("pre").textContent = math;
  } else {
    mathDetails.classList.add("hidden");
  }

  const thumbs = content.querySelector(".thumb-row");
  (bill.photos || []).slice(0, 4).forEach((photo) => {
    const img = document.createElement("img");
    img.alt = photo.name || "Bill photo";
    if (photo.blob) {
      const url = URL.createObjectURL(photo.blob);
      img.src = url;
      img.dataset.objectUrl = url;
      thumbs.appendChild(img);
      return;
    }
    if (photo.path && supabaseClient && currentUser) {
      thumbs.appendChild(img);
      getSignedPhotoUrl(photo.path).then((url) => {
        if (!url) {
          img.remove();
          return;
        }
        img.src = url;
      });
      return;
    }
  });

  const actions = content.querySelector(".bill-actions");
  if (isOpen) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "ghost";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => loadBillForEdit(bill.id));
    actions.appendChild(editBtn);

    if (bill.aiStatus === "failed" || (bill.aiStatus === "pending" && !bill.splits?.length)) {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "ghost";
      retryBtn.textContent = "Retry AI";
      retryBtn.addEventListener("click", async () => {
        const latest = await getBill(bill.id);
        if (!latest) return;
        const result = await runAutoSplit({ bill: latest, silent: false, applyToForm: false });
        if (result) {
          const updatedBill = {
            ...latest,
            splits: result.splits || [],
            splitMath: result.math || "",
            splitDetails: result,
            aiStatus: "done",
            updatedAt: new Date().toISOString(),
          };
          await saveBill(updatedBill);
          await renderLists();
          await runSync();
        }
      });
      actions.appendChild(retryBtn);
    }

    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "ghost";
    doneBtn.textContent = "Mark completed";
    doneBtn.addEventListener("click", () => markCompleted(bill.id));
    actions.appendChild(doneBtn);
  } else {
    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "ghost";
    restoreBtn.textContent = "Restore";
    restoreBtn.addEventListener("click", () => restoreBill(bill.id));
    actions.appendChild(restoreBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "ghost";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      const localBill = await getBill(bill.id);
      if (currentUser && navigator.onLine && localBill) {
        await deleteRemoteBill(localBill);
        await deleteBill(bill.id);
        await renderLists();
      } else {
        await updateBillStatus(bill.id, "deleted");
        await renderLists();
        await runSync();
      }
    });
    actions.appendChild(deleteBtn);
  }

  card.appendChild(swipeBg);
  card.appendChild(content);

  if (isOpen) attachSwipe(card, bill.id);
  return card;
}

function attachSwipe(card, billId) {
  const content = card.querySelector(".bill-content");
  let startX = 0;
  let currentX = 0;
  let dragging = false;
  const threshold = 90;

  content.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    dragging = true;
    startX = event.clientX;
    currentX = 0;
    content.style.transition = "none";
    content.setPointerCapture(event.pointerId);
  });

  content.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    currentX = event.clientX - startX;
    content.style.transform = `translateX(${currentX}px)`;
  });

  function endSwipe(event) {
    if (!dragging) return;
    dragging = false;
    content.releasePointerCapture(event.pointerId);
    if (Math.abs(currentX) > threshold) {
      content.style.transform = "translateX(0)";
      markCompleted(billId);
    } else {
      content.style.transition = "transform 0.2s ease";
      content.style.transform = "translateX(0)";
    }
  }

  content.addEventListener("pointerup", endSwipe);
  content.addEventListener("pointercancel", endSwipe);
}

async function markCompleted(id) {
  await updateBillStatus(id, "completed");
  undoPayload = { id, status: "open" };
  setSnackbar("Marked completed.", "Undo", async () => {
    if (!undoPayload) return;
    await updateBillStatus(undoPayload.id, undoPayload.status);
    undoPayload = null;
    snackbar.classList.remove("show");
    await renderLists();
    await runSync();
  });
  await renderLists();
  await runSync();
}

async function restoreBill(id) {
  await updateBillStatus(id, "open");
  await renderLists();
  await runSync();
}

async function renderLists() {
  cleanupObjectUrls(openList);
  cleanupObjectUrls(completedList);
  openList.innerHTML = "";
  completedList.innerHTML = "";

  const bills = await getAllBills();
  bills.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const openBills = bills.filter((bill) => bill.status !== "completed" && bill.status !== "deleted");
  const completedBills = bills.filter((bill) => bill.status === "completed");

  openCount.textContent = openBills.length;
  completedCount.textContent = completedBills.length;

  if (!openBills.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No open bills yet. Log one above.";
    openList.appendChild(empty);
  }

  if (!completedBills.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No completed bills yet.";
    completedList.appendChild(empty);
  }

  openBills.forEach((bill) => openList.appendChild(createBillCard(bill, true)));
  completedBills.forEach((bill) => completedList.appendChild(createBillCard(bill, false)));
}

async function loadBillForEdit(id) {
  const bill = await getBill(id);
  if (!bill) return;
  editingBillId = bill.id;
  editingBillPhotos = bill.photos || [];

  totalInput.value = bill.total ?? "";
  createdAtInput.value = bill.createdAt ? toInputValue(new Date(bill.createdAt)) : toInputValue(new Date());
  paidByInput.value = bill.paidBy || "";
  notesInput.value = bill.notes || "";

  itemsList.innerHTML = "";
  (bill.items || []).forEach((item) => addItemRow(item));
  if (!bill.items?.length) addItemRow();

  splitsList.innerHTML = "";
  (bill.splits || []).forEach((split) => addSplitRow(split));
  if (!bill.splits?.length) addSplitRow();

  if (bill.splits?.length || bill.splitMath) {
    setManualVisible(true);
  } else {
    setManualVisible(false);
  }

  if (bill.splitMath) {
    splitExplanationText.textContent = bill.splitMath;
    splitExplanation.classList.remove("hidden");
  } else {
    splitExplanationText.textContent = "";
    splitExplanation.classList.add("hidden");
  }

  currentSplitDetails = bill.splitDetails || null;
  updateAmountSummary();
  updateSplitSummary();
  updatePhotoPreview();

  const primaryBtn = form.querySelector(".actions .primary");
  primaryBtn.textContent = "Update bill";
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((btn) => btn.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.tab;
      if (target === "open") {
        openList.classList.remove("hidden");
        completedList.classList.add("hidden");
      } else {
        completedList.classList.remove("hidden");
        openList.classList.add("hidden");
      }
    });
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const totalValue = Number.parseFloat(totalInput.value);
  if (Number.isNaN(totalValue)) return;

  const createdAt = createdAtInput.value
    ? new Date(createdAtInput.value).toISOString()
    : new Date().toISOString();
  const paidByValue = paidByInput.value.trim();
  const items = collectItems();
  const splits = collectSplits();
  const newPhotos = await readPhotos();
  const existing = editingBillId ? await getBill(editingBillId) : null;
  const combinedPhotos = editingBillId
    ? [...(editingBillPhotos || []), ...newPhotos]
    : newPhotos;

  const bill = {
    id: editingBillId || generateId(),
    status: existing?.status || "open",
    createdAt,
    updatedAt: new Date().toISOString(),
    total: totalValue,
    paidBy: paidByValue,
    notes: notesInput.value.trim(),
    items,
    photos: combinedPhotos,
    splits,
    splitMath: splitExplanationText.textContent || "",
    splitDetails: currentSplitDetails || null,
    aiStatus: splits.length ? "manual" : existing?.aiStatus || null,
  };

  const aiReady = (aiServerReady || !!loadOpenAiKey()) && currentUser;
  const shouldAutoSplit = aiToggle.checked && aiReady && !splits.length && !editingBillId;
  if (shouldAutoSplit) {
    bill.aiStatus = "pending";
  }
  await saveBill(bill);
  rememberPeople([
    paidByValue,
    ...items.map((item) => item.person),
    ...splits.map((split) => split?.person).filter(Boolean),
  ]);
  if (paidByValue) localStorage.setItem(LAST_PAID_KEY, paidByValue);
  setSnackbar("Saved to your log.", null, null);
  clearForm();
  await renderLists();
  await runSync();

  if (shouldAutoSplit) {
    const result = await runAutoSplit({ bill, silent: true, applyToForm: false });
    if (result) {
      const updatedBill = {
        ...bill,
        splits: result.splits || [],
        splitMath: result.math || "",
        splitDetails: result,
        aiStatus: "done",
        updatedAt: new Date().toISOString(),
      };
      await saveBill(updatedBill);
      await renderLists();
      await runSync();
    } else {
      const failedBill = { ...bill, aiStatus: "failed", updatedAt: new Date().toISOString() };
      await saveBill(failedBill);
      await renderLists();
    }
    processPendingSplits();
  }
});

addItemBtn.addEventListener("click", () => addItemRow(null, { focus: true }));
resetBtn.addEventListener("click", clearForm);
photosInput.addEventListener("change", updatePhotoPreview);
clearPhotosBtn.addEventListener("click", () => {
  photosInput.value = "";
  editingBillPhotos = [];
  updatePhotoPreview();
});
itemsList.addEventListener("input", updateAmountSummary);
totalInput.addEventListener("input", updateAmountSummary);
splitsList.addEventListener("input", updateSplitSummary);
addSplitBtn.addEventListener("click", () => addSplitRow(null, { focus: true }));
runSplitBtn.addEventListener("click", runAutoSplit);
aiToggle.addEventListener("change", () => {
  localStorage.setItem(AI_PREF_KEY, aiToggle.checked ? "true" : "false");
  updateAiVisibility();
});
manualToggle.addEventListener("change", () => {
  setManualVisible(manualToggle.checked);
});
openManualBtn.addEventListener("click", () => {
  setManualVisible(true);
  splitsList.scrollIntoView({ behavior: "smooth", block: "start" });
});
checkAiBtn.addEventListener("click", checkAiServer);
aiSettingsForm?.addEventListener("submit", (event) => {
  event.preventDefault();
});
saveKeyBtn?.addEventListener("click", () => {
  const value = openAiKeyInput?.value.trim() || "";
  if (!value) {
    setSplitStatus("Paste your OpenAI key to save it.");
    return;
  }
  saveOpenAiKey(value);
  if (openAiKeyInput) openAiKeyInput.value = "";
  updateAiVisibility();
  if (currentUser) {
    checkAiServer();
  }
  setSplitStatus("Key saved locally.");
});
clearKeyBtn?.addEventListener("click", () => {
  clearOpenAiKey();
  updateAiVisibility();
  setSplitStatus("Key cleared.");
});
undoAction.addEventListener("click", () => {
  if (!undoPayload) return;
  updateBillStatus(undoPayload.id, undoPayload.status).then(renderLists);
  undoPayload = null;
  snackbar.classList.remove("show");
});

setupTabs();
clearForm();
updatePeopleDatalist();
updateKeyHint();
updateAiVisibility();
const isLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
if (!isLocalhost) {
  checkAiServer();
}
renderLists();
initAuth();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
