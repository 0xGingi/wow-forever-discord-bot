-- Runs UwucrewSync against a fake WoW API (luajit = Lua 5.1, like the game).
-- usage: luajit addon/test/harness.lua <addon dir> <out SavedVariables file> [secret]
-- Prints the /uwu sync code; writes UwucrewSyncDB the way WoW's serializer does.
local dir, out, mode = arg[1], arg[2], arg[3]

local handlers, timers = {}, {}
local function frame()
  local f = { scripts = {} }
  return setmetatable(f, { __index = function(_, k)
    if k == "SetScript" then return function(self, name, fn) self.scripts[name] = fn end end
    if k == "RegisterEvent" then return function(self) handlers[#handlers + 1] = self end end
    return function() return frame() end -- every other widget method is a no-op returning a widget
  end })
end

local shown
CreateFrame = function(kind)
  local f = frame()
  if kind == "EditBox" then f.SetText = function(_, t) shown = t end end
  return f
end
UIParent, ChatFontNormal, UISpecialFrames, SlashCmdList = {}, {}, {}, {}
tinsert, time, date = table.insert, os.time, os.date -- WoW globals
local realPrint, said = print, {}
print = function(text) said[#said + 1] = tostring(text) end -- chat output, checked below
local function heard(pattern)
  for _, line in ipairs(said) do if line:find(pattern) then return line end end
end
C_Timer = { After = function(_, fn) timers[#timers + 1] = fn end }
issecretvalue = function() return mode == "secret" end
local level = 29
UnitName = function() return "Asha", "Brightvale" end
UnitClass = function() return "Mage", "MAGE" end
UnitRace = function() return "Skyborne", "Skyborne" end
UnitLevel = function() return level end
UnitXP = function() return 1234 end
UnitXPMax = function() return 20000 end
GetGuildInfo = function() return "uwucrew", "Officer", 1 end
GetMoney = function() return 1234567 end
GetAverageItemLevel = function() return 31.2, 30.6 end
RequestRaidInfo, RequestTimePlayed = function() end, function() end
GetInventoryItemLink = function(_, slot)
  if slot == 1 then return "|cff0070dd|Hitem:271766::::::::30:::::|h[Heavehammer \"the Big\"]|h|r" end
  if slot == 16 then return "|cff1eff00|Hitem:280612::::::::30:::::|h[Night Watchman's Torch]|h|r" end
end
C_Item = { GetItemQualityByID = function(id) return id == 271766 and 3 or 2 end, GetDetailedItemLevelInfo = function() return 31 end }
GetProfessions = function() return 1, 2, nil, 4 end
GetProfessionInfo = function(i) return ({ "Tailoring", "Enchanting", nil, "Fishing" })[i], 0, 150 + i, 225 end
GetNumSavedInstances = function() return 2 end
GetSavedInstanceInfo = function(i)
  if i == 1 then return "Hall of Thanes", 1, 3600, 1, true, false, 0, false, 5, "Normal", 4, 3 end
  return "Hyjal Summit", 2, 86400, 1, true, false, 0, true, 20, "20 Player", 5, 2
end
local HYJAL = { "Rage Winterchill", "Anetheron", "Kaz'rogal", "Azgalor", "Archimonde" }
GetSavedInstanceEncounterInfo = function(_, e) return HYJAL[e], 0, e <= 2 end
C_GameRules = { IsHardcoreActive = function() return true end }
GetZoneText = function() return "Wetlands" end
-- Classic-style profession window: a header and two recipes.
local skills = { { "Cloth", "header" }, { "Bolt of Silk Cloth", "optimal" }, { "Azure Silk Hood", "medium" } }
GetTradeSkillLine = function() return "Tailoring", 151, 225 end
GetNumTradeSkills = function() return #skills end
GetTradeSkillInfo = function(i) return skills[i][1], skills[i][2] end
-- What the uwucrew Sync app writes into GuildData.lua.
UwucrewSyncGuild = {
  raids = { { title = "Hyjal Summit", t = os.time() + 3600, mine = "Healer", going = 12, size = 20 }, { title = "Old raid", t = os.time() - 60 } },
  quests = { [1002] = { "Party Member", "Asha Brightvale" } },
}
C_Reputation = {
  GetNumFactions = function() return 3 end,
  GetFactionDataByIndex = function(i)
    return ({
      { name = "Alliance", isHeader = true },
      { name = "Ironforge", reaction = 6, currentStanding = 9500, currentReactionThreshold = 9000, nextReactionThreshold = 21000 },
      { name = "Skywall", reaction = 5, currentStanding = 3500, currentReactionThreshold = 3000, nextReactionThreshold = 9000 },
    })[i]
  end,
}
-- A full quest log (Forever allows 40): 4 zone headers, 40 quests, objectives on each (big enough to force the paste code to trim).
local log = {}
for z, zone in ipairs({ "Wetlands", "Zephras Isle", "Hall of Thanes", "Riverglades" }) do
  log[#log + 1] = { title = zone, isHeader = true }
  for n = 1, 10 do
    log[#log + 1] = { title = ("The Long and Winding Errand of %s, Part %d"):format(zone, n), questID = z * 1000 + n, level = 20 + n }
  end
end
C_QuestLog = {
  GetAllCompletedQuestIDs = function() return { 1, 2, 3, 4, 5 } end,
  GetNumQuestLogEntries = function() return #log end,
  GetInfo = function(i) return log[i] end,
  IsComplete = function(id) return id % 10 == 1 end,
  GetQuestObjectives = function(id)
    return { { text = "Gnoll Paw: 3/8", finished = false }, { text = "Speak with Foreman Thistlenettle", finished = id % 2 == 0 } }
  end,
}
GetSpecialization = function() return 1 end
GetSpecializationRole = function() return "DAMAGER" end

local function fire(event, ...)
  for _, f in ipairs(handlers) do if f.scripts.OnEvent then f.scripts.OnEvent(f, event, ...) end end
  while #timers > 0 do table.remove(timers, 1)() end
end

assert(loadfile(dir .. "/UwucrewSync.lua"))("UwucrewSync", {})
assert(loadfile(dir .. "/GuildData.lua"), "the stub GuildData.lua the release ships must load")
fire("ADDON_LOADED", "UwucrewSync")
fire("PLAYER_LOGIN")
assert(heard("next raid: .*Hyjal Summit.*Healer"), "login shows the next raid from the app's guild info")
assert(not heard("Old raid"), "raids that already started are skipped")
fire("TRADE_SKILL_SHOW")
fire("QUEST_ACCEPTED", 7, 1002)
assert(heard("also on this quest: .*Party Member"), "accepting a quest names guildmates on it")
assert(not heard("also on this quest: .*Asha Brightvale"), "but not the player themself")
fire("TIME_PLAYED_MSG", 86400, 3600)
level = 29 -- UnitLevel lags behind during PLAYER_LEVEL_UP; the event arg is the truth
fire("PLAYER_LEVEL_UP", 30)
assert(UwucrewSyncDB.exports["Asha Brightvale"]:find('"level":30', 1, true), "level-up event should record the new level")
level = 30 -- the game catches up a moment later
SlashCmdList.UWUCREW("link not-a-code")
assert(UwucrewSyncDB.link == nil, "bad link codes are rejected")
SlashCmdList.UWUCREW("link " .. (os.getenv("UWU_LINK") or "uwusync-TestCode_Case-Sensitive"))
assert(UwucrewSyncDB.link == (os.getenv("UWU_LINK") or "uwusync-TestCode_Case-Sensitive"), "link codes keep their case")
SlashCmdList.UWUCREW("raids")
assert(heard("Hyjal Summit.*12/20"), "/uwu raids lists upcoming raids")
fire("PLAYER_DEAD") -- a Hardcore death
SlashCmdList.UWUCREW("sync")
fire("PLAYER_LOGOUT")
local full = UwucrewSyncDB.exports["Asha Brightvale"]
assert(full:find('"recipes":{"Tailoring":["Azure Silk Hood","Bolt of Silk Cloth"]}', 1, true), "the app's upload carries recipes")
assert(full:find('"b":["Rage Winterchill","Anetheron"]', 1, true), "raid lockouts name the bosses killed")
assert(full:find('"died":{', 1, true) and full:find('"hc":true', 1, true), "a Hardcore death is recorded")
assert(not shown:find('"recipes"', 1, true), "recipes are left out of paste codes")
assert(shown and #shown <= 3900, "paste code must fit a Discord modal, got " .. (shown and #shown or 0))
assert(shown:find('"logMore":', 1, true) and shown:find('"log":[{', 1, true), "a full 40-quest log keeps as many quests as fit in the paste code")
assert(UwucrewSyncDB.exports["Asha Brightvale"]:find("Gnoll Paw", 1, true), "the app's full upload keeps quest objectives")
realPrint(shown or "NO EXPORT")

-- Mimic WoW's SavedVariables writer (%q-quoted strings).
local function ser(v, indent)
  if type(v) == "table" then
    local lines = { "{" }
    for k, x in pairs(v) do lines[#lines + 1] = indent .. "\t[" .. string.format("%q", k) .. "] = " .. ser(x, indent .. "\t") .. "," end
    lines[#lines + 1] = indent .. "}"
    return table.concat(lines, "\n")
  end
  return type(v) == "string" and string.format("%q", v) or tostring(v)
end
local f = assert(io.open(out, "w"))
f:write("\nUwucrewSyncDB = " .. ser(UwucrewSyncDB or {}, "") .. "\n")
f:close()
