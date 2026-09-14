/** Bound Apps Script for UpdatedPlan. No camera access, inventory writes or LLM calls. */
function installRackHandPlanTriggers() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('RACKHAND_SPREADSHEET_ID', sheet.getId());
  const handlers = ['rackhandPlanEdited', 'rackhandPlanStructureChanged', 'rackhandPlanOpened'];
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('rackhandPlanEdited').forSpreadsheet(sheet).onEdit().create();
  ScriptApp.newTrigger('rackhandPlanStructureChanged').forSpreadsheet(sheet).onChange().create();
  ScriptApp.newTrigger('rackhandPlanOpened').forSpreadsheet(sheet).onOpen().create();
  sendRackHandPlanChange(); // Initial snapshot, including tomorrow's already-existing plan.
}

function rackhandPlanEdited(event) {
  if (event && event.range && event.range.getSheet().getName() !== 'UpdatedPlan') return;
  sendRackHandPlanChange();
}

function rackhandPlanStructureChanged(event) {
  if (event && event.changeType === 'EDIT') return; // Covered by onEdit.
  sendRackHandPlanChange();
}

function rackhandPlanOpened() {
  // Opening the Sheet on a new day detects the next tomorrow without scheduled scans.
  const properties = PropertiesService.getScriptProperties();
  const timeZone = properties.getProperty('RACKHAND_TIME_ZONE') || 'Asia/Ulaanbaatar';
  const today = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  if (properties.getProperty('RACKHAND_LAST_OPEN_DATE') !== today) {
    sendRackHandPlanChange();
    properties.setProperty('RACKHAND_LAST_OPEN_DATE', today);
  }
}

function sendRackHandPlanChange() {
  const properties = PropertiesService.getScriptProperties();
  const url = properties.getProperty('RACKHAND_WEBHOOK_URL');
  const secret = properties.getProperty('RACKHAND_WEBHOOK_SECRET');
  if (!url || !/^https:\/\//.test(url) || !secret || secret.length < 32)
    throw new Error('Configure an HTTPS RACKHAND_WEBHOOK_URL and a 32+ character RACKHAND_WEBHOOK_SECRET in Script Properties.');
  const spreadsheetId = properties.getProperty('RACKHAND_SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('Run installRackHandPlanTriggers first.');
  const body = JSON.stringify({ spreadsheetId: spreadsheetId, occurredAt: Date.now() });
  const signature = Utilities.computeHmacSha256Signature(body, secret, Utilities.Charset.UTF_8)
    .map(function(byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
  let response;
  try {
    response = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', payload: body,
    headers: { 'x-rackhand-signature': signature }, muteHttpExceptions: true,
    });
  } catch (error) {
    scheduleRackHandDeliveryRetry();
    throw error;
  }
  if (response.getResponseCode() !== 202) {
    scheduleRackHandDeliveryRetry();
    // Explicit failure in Apps Script Executions; never claim delivery succeeded.
    throw new Error('RackHand did not accept the Sheet update (HTTP ' + response.getResponseCode() + '). Run sendRackHandPlanChange after restoring connectivity.');
  }
  properties.deleteProperty('RACKHAND_DELIVERY_RETRIES');
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'rackhandRetryDelivery') ScriptApp.deleteTrigger(trigger);
  });
}

/** One-off retries of a failed EVENT delivery, never scheduled Sheet scans. */
function scheduleRackHandDeliveryRetry() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const properties = PropertiesService.getScriptProperties();
    const count = Number(properties.getProperty('RACKHAND_DELIVERY_RETRIES') || '0');
    if (count >= 5) return; // Leave the honest execution error for manual recovery.
    if (ScriptApp.getProjectTriggers().some(function(trigger) { return trigger.getHandlerFunction() === 'rackhandRetryDelivery'; })) return;
    properties.setProperty('RACKHAND_DELIVERY_RETRIES', String(count + 1));
    ScriptApp.newTrigger('rackhandRetryDelivery').timeBased().after(60000).create();
  } finally { lock.releaseLock(); }
}

function rackhandRetryDelivery() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'rackhandRetryDelivery') ScriptApp.deleteTrigger(trigger);
  });
  sendRackHandPlanChange();
}
