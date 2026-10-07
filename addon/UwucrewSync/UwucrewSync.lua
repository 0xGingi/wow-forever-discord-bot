-- uwucrew Sync: snapshots your character for the uwucrew Discord bot.
-- Addons can't reach the internet, so the data leaves the game two ways:
--   /uwu sync         shows a code to paste into /sync paste in Discord
--   /uwu link <code>  ties this WoW account to your Discord account; the uwucrew-sync app then uploads
--                     this addon's saved file after every logout or /reload, for every character on the account
-- Every game API is looked up defensively: Forever is still in beta and functions come and go between builds.

local ADDON = ...
local VERSION = 1
local PREFIX = "UWU1:"
local MAX_EXPORT = 3900 -- Discord modal fields hold 4000 characters

local db -- UwucrewSyncDB, ready after ADDON_LOADED

-- Midnight-era "secret values" (names, health...) throw if compared or printed; treat them as unknown.
local function known(v)
  if issecretvalue and issecretvalue(v) then return nil end
  return v
end

---------------------------------------------------------------- JSON

local function encode(v)
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "boolean" then return tostring(v) end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    if math.floor(v) == v then return string.format("%.0f", v) end
    return string.format("%.2f", v)
  end
  if t == "string" then
    return '"' .. (v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end)) .. '"'
  end
  local out = {}
  if v[1] ~= nil or next(v) == nil then
    for i = 1, #v do out[i] = encode(v[i]) end
    return "[" .. table.concat(out, ",") .. "]"
  end
  local keys = {}
  for k in pairs(v) do keys[#keys + 1] = k end
  table.sort(keys)
  for _, k in ipairs(keys) do out[#out + 1] = encode(tostring(k)) .. ":" .. encode(v[k]) end
  return "{" .. table.concat(out, ",") .. "}"
end

---------------------------------------------------------------- collectors

local GEAR_SLOTS = { 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 } -- skips shirt (4) and tabard (19)

local function gear()
  local items = {}
  for _, slot in ipairs(GEAR_SLOTS) do
    local link = GetInventoryItemLink("player", slot)
    local id = link and tonumber(link:match("item:(%d+)"))
    if id then
      local item = { s = slot, id = id, n = link:match("%[(.-)%]") }
      if C_Item and C_Item.GetItemQualityByID then item.q = C_Item.GetItemQualityByID(id) end
      if C_Item and C_Item.GetDetailedItemLevelInfo then item.l = C_Item.GetDetailedItemLevelInfo(link) end
      items[#items + 1] = item
    end
  end
  return items
end

local function professions()
  local list = {}
  if GetProfessions and GetProfessionInfo then
    for _, index in pairs({ GetProfessions() }) do
      local name, _, rank, max = GetProfessionInfo(index)
      if name then list[#list + 1] = { n = name, r = rank, m = max } end
    end
  elseif GetNumSkillLines and GetSkillLineInfo then -- classic-style skill list, in case Forever brings it back
    for i = 1, GetNumSkillLines() do
      local name, header, _, rank, _, _, max = GetSkillLineInfo(i)
      if name and not header and max and max > 1 then list[#list + 1] = { n = name, r = rank, m = max } end
    end
  end
  return list
end

local function lockouts()
  local list = {}
  if not (GetNumSavedInstances and GetSavedInstanceInfo) then return list end
  for i = 1, GetNumSavedInstances() do
    local name, _, reset, _, locked, _, _, isRaid, _, _, total, done = GetSavedInstanceInfo(i)
    if name and locked then list[#list + 1] = { n = name, raid = isRaid and true or false, k = done, of = total, reset = time() + (reset or 0) } end
  end
  return list
end

local function reputations()
  local all = {}
  local function add(name, reaction, value, min, max, isHeader)
    if name and reaction and not isHeader then all[#all + 1] = { n = name, r = reaction, p = (value or 0) - (min or 0), m = (max or 0) - (min or 0) } end
  end
  if C_Reputation and C_Reputation.GetNumFactions and C_Reputation.GetFactionDataByIndex then
    for i = 1, C_Reputation.GetNumFactions() do
      local f = C_Reputation.GetFactionDataByIndex(i)
      if f then add(f.name, f.reaction, f.currentStanding, f.currentReactionThreshold, f.nextReactionThreshold, f.isHeader and not f.isHeaderWithRep) end
    end
  elseif GetNumFactions and GetFactionInfo then
    for i = 1, GetNumFactions() do
      local name, _, reaction, min, max, value, _, _, isHeader, _, hasRep = GetFactionInfo(i)
      add(name, reaction, value, min, max, isHeader and not hasRep)
    end
  end
  table.sort(all, function(a, b) if a.r ~= b.r then return a.r > b.r end return a.p > b.p end)
  local top = {}
  for i = 1, math.min(8, #all) do top[i] = all[i] end
  return top
end

-- Current quest log, grouped under the zone headers it appears under.
-- ponytail: quests under a collapsed zone header aren't listed by the game; expanding headers would move the player's UI.
local function questLog()
  local list, zone = {}, nil
  if C_QuestLog and C_QuestLog.GetNumQuestLogEntries and C_QuestLog.GetInfo then
    for i = 1, C_QuestLog.GetNumQuestLogEntries() do
      local q = C_QuestLog.GetInfo(i)
      if q and q.isHeader then
        zone = q.title
      elseif q and q.questID and q.questID > 0 and not q.isHidden then
        local entry = { id = q.questID, n = q.title, l = q.level, z = zone, c = (C_QuestLog.IsComplete and C_QuestLog.IsComplete(q.questID)) and true or false, o = {} }
        for _, o in ipairs((C_QuestLog.GetQuestObjectives and C_QuestLog.GetQuestObjectives(q.questID)) or {}) do
          if o.text and o.text ~= "" then entry.o[#entry.o + 1] = { t = o.text, d = o.finished and true or false } end
        end
        list[#list + 1] = entry
      end
    end
  elseif GetNumQuestLogEntries and GetQuestLogTitle then -- classic-style quest log
    for i = 1, GetNumQuestLogEntries() do
      local title, level, _, isHeader, _, isComplete, _, questID = GetQuestLogTitle(i)
      if isHeader then
        zone = title
      elseif title and questID then
        list[#list + 1] = { id = questID, n = title, l = level, z = zone, c = isComplete == 1 or isComplete == true, o = {} }
      end
    end
  end
  return list
end

local function questsDone()
  if C_QuestLog and C_QuestLog.GetAllCompletedQuestIDs then return #(C_QuestLog.GetAllCompletedQuestIDs() or {}) end
end

local ROLE = { TANK = "Tank", HEALER = "Healer", DAMAGER = "DPS" }
local function role()
  if not (GetSpecialization and GetSpecializationRole) then return nil end
  local spec = GetSpecialization()
  return spec and ROLE[GetSpecializationRole(spec)]
end

---------------------------------------------------------------- snapshot

local function charKey()
  local first, surname = UnitName("player")
  first, surname = known(first), known(surname)
  if not first then return nil end
  return first, surname
end

local function snapshot(levelOverride)
  local first, surname = charKey()
  if not first or not db then return nil end
  local key = surname and (first .. " " .. surname) or first
  local _, classFile = UnitClass("player")
  local raceName, raceFile = UnitRace("player")
  local ilvl
  if GetAverageItemLevel then ilvl = select(2, GetAverageItemLevel()) end

  local data = {
    v = VERSION, t = time(), first = first, last = surname,
    level = levelOverride or UnitLevel("player"), xp = UnitXP("player"), xpMax = UnitXPMax("player"),
    class = classFile, race = raceName, raceFile = raceFile, role = role(),
    guild = known(GetGuildInfo("player")), money = GetMoney(), played = db.played[key],
    ilvl = ilvl and math.floor(ilvl + 0.5), quests = questsDone(),
    gear = gear(), profs = professions(), lockouts = lockouts(), reps = reputations(), log = questLog(),
  }
  db.exports[key] = PREFIX .. encode(data) -- the app uploads this in full
  return data, key
end

-- The paste code has to fit a Discord modal, so shed the least important detail until it does.
local TRIMS = {
  function(d) for _, q in ipairs(d.log) do q.o = {} end end, -- quest objectives
  function(d) d.reps = {} end,
  function(d) for _, item in ipairs(d.gear) do item.n = nil end end, -- item names (ids stay, the bot links them)
  function(d) for _, q in ipairs(d.log) do q.z = nil end end, -- quest zones
}
local function pasteCode(data)
  local text = PREFIX .. encode(data)
  for _, trim in ipairs(TRIMS) do
    if #text <= MAX_EXPORT then break end
    trim(data)
    text = PREFIX .. encode(data)
  end
  -- Last resort: keep as many quests as fit (the log holds up to 40) and say how many were left out.
  while #text > MAX_EXPORT and #data.log > 0 do
    table.remove(data.log)
    data.logMore = (data.logMore or 0) + 1
    text = PREFIX .. encode(data)
  end
  return text
end

---------------------------------------------------------------- export window

local frame
local function showExport(text)
  if not frame then
    frame = CreateFrame("Frame", "UwucrewSyncExport", UIParent, "BackdropTemplate")
    frame:SetSize(520, 240)
    frame:SetPoint("CENTER")
    frame:SetFrameStrata("DIALOG")
    frame:SetBackdrop({
      bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
      edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
      tile = true, tileSize = 32, edgeSize = 32,
      insets = { left = 11, right = 12, top = 12, bottom = 11 },
    })
    frame:EnableMouse(true)
    frame:SetMovable(true)
    frame:RegisterForDrag("LeftButton")
    frame:SetScript("OnDragStart", frame.StartMoving)
    frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
    tinsert(UISpecialFrames, "UwucrewSyncExport") -- Esc closes it

    local title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
    title:SetPoint("TOP", 0, -18)
    title:SetText("uwucrew Sync")

    local hint = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    hint:SetPoint("BOTTOM", 0, 18)
    hint:SetText("Press |cffffd100Ctrl+C|r, then use |cffffd100/sync paste|r in Discord")

    local scroll = CreateFrame("ScrollFrame", nil, frame, "UIPanelScrollFrameTemplate")
    scroll:SetPoint("TOPLEFT", 22, -44)
    scroll:SetPoint("BOTTOMRIGHT", -40, 40)

    local edit = CreateFrame("EditBox", nil, scroll)
    edit:SetMultiLine(true)
    edit:SetFontObject(ChatFontNormal)
    edit:SetWidth(450)
    edit:SetAutoFocus(true)
    edit:SetScript("OnEscapePressed", function() frame:Hide() end)
    -- Read-only: any typing snaps back to the code, fully selected.
    edit:SetScript("OnTextChanged", function(self, userInput)
      if userInput then self:SetText(frame.code); self:HighlightText() end
    end)
    scroll:SetScrollChild(edit)
    frame.edit = edit

    local close = CreateFrame("Button", nil, frame, "UIPanelCloseButton")
    close:SetPoint("TOPRIGHT", -6, -6)
  end
  frame.code = text
  frame.edit:SetText(text)
  frame:Show()
  frame.edit:SetFocus()
  frame.edit:HighlightText()
end

---------------------------------------------------------------- events

local pending = false
local function snapshotSoon()
  -- Equipment and money events arrive in bursts; one snapshot after they settle is enough.
  if pending then return end
  pending = true
  C_Timer.After(2, function() pending = false; snapshot() end)
end

local events = CreateFrame("Frame")
events:RegisterEvent("ADDON_LOADED")
events:RegisterEvent("PLAYER_LOGIN")
events:RegisterEvent("PLAYER_LEVEL_UP")
events:RegisterEvent("PLAYER_EQUIPMENT_CHANGED")
events:RegisterEvent("PLAYER_MONEY")
events:RegisterEvent("UPDATE_INSTANCE_INFO")
events:RegisterEvent("TIME_PLAYED_MSG")
events:RegisterEvent("QUEST_LOG_UPDATE") -- accepted, progressed, abandoned
events:RegisterEvent("QUEST_TURNED_IN")
events:RegisterEvent("PLAYER_LOGOUT")
events:SetScript("OnEvent", function(_, event, ...)
  if event == "ADDON_LOADED" then
    if ... ~= ADDON then return end
    UwucrewSyncDB = UwucrewSyncDB or {}
    db = UwucrewSyncDB
    db.exports = db.exports or {}
    db.played = db.played or {}
  elseif event == "PLAYER_LOGIN" then
    if RequestRaidInfo then RequestRaidInfo() end -- fills lockouts, answered by UPDATE_INSTANCE_INFO
    snapshotSoon()
  elseif event == "PLAYER_LEVEL_UP" then
    snapshot((...)) -- UnitLevel still reports the old level during this event
  elseif event == "TIME_PLAYED_MSG" then
    local first, surname = charKey()
    if first and db then db.played[surname and (first .. " " .. surname) or first] = (...) end
    snapshotSoon()
  elseif event == "PLAYER_LOGOUT" then
    snapshot()
  else
    snapshotSoon()
  end
end)

---------------------------------------------------------------- slash command

local function say(text) print("|cffff69b4uwucrew|r: " .. text) end

SLASH_UWUCREW1 = "/uwu"
SLASH_UWUCREW2 = "/uwucrew"
SlashCmdList.UWUCREW = function(msg)
  local cmd, rest = (msg or ""):match("^%s*(%S*)%s*(.-)%s*$")
  cmd = cmd:lower()
  if cmd == "" or cmd == "sync" then
    local data = snapshot()
    if not data then return say("couldn't read your character yet, try again in a moment.") end
    showExport(pasteCode(data))
    if RequestTimePlayed then RequestTimePlayed() end -- refreshes time played for the next sync
  elseif cmd == "link" then
    if not rest:match("^uwusync%-[%w_%-]+$") then return say("paste the code from |cffffd100/sync link|r in Discord: |cffffd100/uwu link uwusync-...|r") end
    db.link = rest
    snapshot()
    say("linked! Every character on this WoW account now syncs to your Discord. Type |cffffd100/reload|r once to save it, and keep the uwucrew-sync app running.")
  elseif cmd == "unlink" then
    db.link = nil
    say("unlinked. |cffffd100/reload|r to save.")
  else
    say("|cffffd100/uwu sync|r shows your sync code · |cffffd100/uwu link <code>|r connects this WoW account to Discord · " .. (db and db.link and "|cff1eff00linked|r" or "|cff9d9d9dnot linked|r"))
  end
end
