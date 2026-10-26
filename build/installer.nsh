; electron-builder 自动带上这个文件。
; 送件用的 reellab:// 协议：NSIS 安装包不读 build.protocols（那只管 mac、appx、linux），这里自己写注册表。
; 装好还没打开过时别的应用也能叫醒；卸载时删掉，免得注册表里留着指向已删 exe 的协议，发件方以为还装着。
; 写的位置和内容同运行时 app.setAsDefaultProtocolClient（HKCU\Software\Classes\reellab），每次启动会再写一遍。

!macro customInstall
  WriteRegStr HKCU "Software\Classes\reellab" "" "URL:reellab"
  WriteRegStr HKCU "Software\Classes\reellab" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\reellab\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; 自动更新时也会先跑旧版的卸载程序，那时别删
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\reellab"
  ${endif}
!macroend
