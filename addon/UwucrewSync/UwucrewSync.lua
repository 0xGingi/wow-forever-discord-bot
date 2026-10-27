-- uwucrew Sync: snapshots your character for the uwucrew Discord bot.
-- Addons can't reach the internet, so the data leaves the game two ways:
--   /uwu sync         shows a code to paste into /sync paste in Discord
--   /uwu link <code>  ties this WoW account to your Discord account; the uwucrew Sync app then uploads
--                     this addon's saved file after every logout or /reload, for every character on the account
-- Guild info comes back in through GuildData.lua, which the app rewrites and the game loads on login or /reload.
-- Every game API is looked up defensively: Forever is new and functions can change between patches.

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
    if name and locked then
      local entry = { n = name, raid = isRaid and true or false, k = done, of = total, reset = time() + (reset or 0) }
      if isRaid and GetSavedInstanceEncounterInfo then -- which bosses, for the guild's first-kill announcements
        entry.b = {}
        for e = 1, total or 0 do
          local boss, _, killed = GetSavedInstanceEncounterInfo(i, e)
          if boss and killed then entry.b[#entry.b + 1] = boss end
        end
      end
      list[#list + 1] = entry
    end
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

-- Recipes can only be read while a profession window is open, so each character's list is kept until it's opened again.
local function recipes()
  local prof, names = nil, {}
  if C_TradeSkillUI and C_TradeSkillUI.GetAllRecipeIDs and C_TradeSkillUI.GetRecipeInfo then
    if C_TradeSkillUI.IsTradeSkillLinked and C_TradeSkillUI.IsTradeSkillLinked() then return nil end -- someone else's
    local info = C_TradeSkillUI.GetBaseProfessionInfo and C_TradeSkillUI.GetBaseProfessionInfo()
    prof = info and info.professionName
    for _, id in ipairs(C_TradeSkillUI.GetAllRecipeIDs() or {}) do
      local r = C_TradeSkillUI.GetRecipeInfo(id)
      if r and r.learned and r.name then names[#names + 1] = r.name end
    end
  elseif GetTradeSkillLine and GetNumTradeSkills and GetTradeSkillInfo then -- classic-style
    prof = GetTradeSkillLine()
    for i = 1, GetNumTradeSkills() do
      local name, kind = GetTradeSkillInfo(i)
      if name and kind ~= "header" and kind ~= "subheader" then names[#names + 1] = name end
    end
  end
  if not prof or prof == "UNKNOWN" or #names == 0 then return nil end
  table.sort(names)
  return prof, names
end

local function crafts() -- classic Enchanting uses the separate Craft window
  if not (GetCraftDisplaySkillLine and GetNumCrafts and GetCraftInfo) then return nil end
  local prof, names = GetCraftDisplaySkillLine(), {}
  for i = 1, GetNumCrafts() do
    local name, _, kind = GetCraftInfo(i)
    if name and kind ~= "header" then names[#names + 1] = name end
  end
  if not prof or #names == 0 then return nil end
  table.sort(names)
  return prof, names
end

local hardcore = function() return C_GameRules and C_GameRules.IsHardcoreActive and C_GameRules.IsHardcoreActive() or false end

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

local function currentKey()
  local first, surname = charKey()
  if not first then return nil end
  return surname and (first .. " " .. surname) or first, first, surname
end

local function snapshot(levelOverride)
  local key, first, surname = currentKey()
  if not key or not db then return nil end
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
    recipes = db.recipes[key], hc = hardcore() or nil, died = db.deaths[key],
  }
  db.exports[key] = PREFIX .. encode(data) -- the app uploads this in full
  return data, key
end

-- The paste code has to fit a Discord modal, so shed the least important detail until it does.
local TRIMS = {
  function(d) d.recipes = nil end, -- far too long for a paste code; the app uploads them
  function(d) for _, q in ipairs(d.log) do q.o = {} end end, -- quest objectives
  function(d) for _, l in ipairs(d.lockouts) do l.b = nil end end, -- boss names
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

---------------------------------------------------------------- guild info from the app

local function say(text) print("|cffff69b4uwucrew|r: " .. text) end

local guild = function() return type(UwucrewSyncGuild) == "table" and UwucrewSyncGuild or nil end

local function upcomingRaids()
  local list = {}
  for _, r in ipairs((guild() or {}).raids or {}) do
    if type(r) == "table" and r.t and r.t > time() then list[#list + 1] = r end
  end
  table.sort(list, function(a, b) return a.t < b.t end)
  return list
end

local function raidLine(r)
  local when = date("%a %b %d, %I:%M %p", r.t)
  local status = r.mine and ("you're in as |cffffd100" .. r.mine .. "|r") or "|cff9d9d9dnot signed up|r"
  return ("|cffffd100%s|r %s · %d/%s · %s"):format(r.title or "Raid", when, r.going or 0, r.size or "?", status)
end

-- Guildmates on a quest, leaving out whoever is playing.
local function questmates(id)
  local names, me = {}, currentKey()
  for _, name in ipairs(((guild() or {}).quests or {})[id] or {}) do
    if name ~= me then names[#names + 1] = name end
  end
  return names
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
events:RegisterEvent("QUEST_ACCEPTED")
-- Not every client has these; registering an unknown event is an error, so try each one.
for _, e in ipairs({ "TRADE_SKILL_SHOW", "TRADE_SKILL_UPDATE", "TRADE_SKILL_LIST_UPDATE", "CRAFT_SHOW", "CRAFT_UPDATE", "PLAYER_DEAD" }) do
  pcall(events.RegisterEvent, events, e)
end

local recipesPending = false
local function rememberRecipes(read)
  if recipesPending then return end -- the window fires a burst of updates; read once they settle
  recipesPending = true
  C_Timer.After(1, function()
    recipesPending = false
    local key = currentKey()
    local prof, names = read()
    if key and db and prof then
      db.recipes[key] = db.recipes[key] or {}
      db.recipes[key][prof] = names
    end
  end)
end

events:SetScript("OnEvent", function(_, event, ...)
  if event == "ADDON_LOADED" then
    if ... ~= ADDON then return end
    UwucrewSyncDB = UwucrewSyncDB or {}
    db = UwucrewSyncDB
    db.exports = db.exports or {}
    db.played = db.played or {}
    db.recipes = db.recipes or {}
    db.deaths = db.deaths or {}
  elseif event == "PLAYER_LOGIN" then
    if RequestRaidInfo then RequestRaidInfo() end -- fills lockouts, answered by UPDATE_INSTANCE_INFO
    snapshotSoon()
    C_Timer.After(8, function() -- after the login chat spam
      local r = upcomingRaids()[1]
      if r then say("next raid: " .. raidLine(r)) end
    end)
  elseif event == "TRADE_SKILL_SHOW" or event == "TRADE_SKILL_UPDATE" or event == "TRADE_SKILL_LIST_UPDATE" then
    rememberRecipes(recipes)
  elseif event == "CRAFT_SHOW" or event == "CRAFT_UPDATE" then
    rememberRecipes(crafts)
  elseif event == "PLAYER_DEAD" then
    local key = currentKey()
    if hardcore() and key and db and not db.deaths[key] then
      db.deaths[key] = { t = time(), l = UnitLevel("player"), z = GetZoneText and known(GetZoneText()) or nil }
      snapshot()
    end
  elseif event == "QUEST_ACCEPTED" then
    local a, b = ...
    local names = questmates(b or a) -- classic passes (logIndex, questID), newer clients just questID
    if #names > 0 then say("also on this quest: |cffffd100" .. table.concat(names, ", ") .. "|r") end
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
  elseif cmd == "raids" then
    local list = upcomingRaids()
    if not guild() then return say("no guild info yet. It comes from the uwucrew Sync app; |cffffd100/reload|r after opening it.") end
    if #list == 0 then return say("no raids scheduled.") end
    for _, r in ipairs(list) do say(raidLine(r)) end
  elseif cmd == "quests" then
    if not guild() then return say("no guild info yet. It comes from the uwucrew Sync app; |cffffd100/reload|r after opening it.") end
    local any = false
    for _, q in ipairs(questLog()) do
      local names = questmates(q.id)
      if #names > 0 then any = true; say(("|cffffd100%s|r: %s"):format(q.n, table.concat(names, ", "))) end
    end
    if not any then say("no guildmates on your quests right now.") end
  else
    say("|cffffd100/uwu sync|r shows your sync code · |cffffd100/uwu link <code>|r connects this WoW account to Discord · |cffffd100/uwu raids|r upcoming raids · |cffffd100/uwu quests|r guildmates on your quests · " .. (db and db.link and "|cff1eff00linked|r" or "|cff9d9d9dnot linked|r"))
  end
end
