' Starts the AdBrain manager with no console window, detached from any shell.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\Admin\Desktop\adbrain-discovery"
sh.Run "cmd /c ""C:\Program Files\nodejs\node.exe"" manager\server.js >> manager\manager.log 2>&1", 0, False
