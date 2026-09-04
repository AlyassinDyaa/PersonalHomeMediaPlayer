' Start the library server with no console window.
'
' Task Scheduler can hide a task, but a .cmd still flashes a console at logon;
' running it through wscript with a window style of 0 avoids that entirely.
CreateObject("WScript.Shell").Run """" & _
  CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & _
  "\start-library-server.cmd""", 0, False
