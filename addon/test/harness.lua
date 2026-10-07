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
tinsert, time = table.insert, os.time -- WoW globals
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
GetNumSavedInstances = function() return 1 end
GetSavedInstanceInfo = function() return "Hall of Thanes", 1, 3600, 1, true, false, 0, false, 5, "Normal", 4, 3 end
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
fire("ADDON_LOADED", "UwucrewSync")
fire("PLAYER_LOGIN")
fire("TIME_PLAYED_MSG", 86400, 3600)
level = 29 -- UnitLevel lags behind during PLAYER_LEVEL_UP; the event arg is the truth
fire("PLAYER_LEVEL_UP", 30)
assert(UwucrewSyncDB.exports["Asha Brightvale"]:find('"level":30', 1, true), "level-up event should record the new level")
level = 30 -- the game catches up a moment later
SlashCmdList.UWUCREW("link not-a-code")
assert(UwucrewSyncDB.link == nil, "bad link codes are rejected")
SlashCmdList.UWUCREW("link " .. (os.getenv("UWU_LINK") or "uwusync-TestCode_Case-Sensitive"))
assert(UwucrewSyncDB.link == (os.getenv("UWU_LINK") or "uwusync-TestCode_Case-Sensitive"), "link codes keep their case")
SlashCmdList.UWUCREW("sync")
fire("PLAYER_LOGOUT")
assert(shown and #shown <= 3900, "paste code must fit a Discord modal, got " .. (shown and #shown or 0))
assert(shown:find('"logMore":', 1, true) and shown:find('"log":[{', 1, true), "a full 40-quest log keeps as many quests as fit in the paste code")
assert(UwucrewSyncDB.exports["Asha Brightvale"]:find("Gnoll Paw", 1, true), "the app's full upload keeps quest objectives")
print(shown or "NO EXPORT")

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
