; Lets guests' phones on the booth Wi-Fi open their photos from this laptop
; (the app serves them on port 47777-47797). Private networks only.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="photobooth4u guest photos"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="photobooth4u guest photos" dir=in action=allow program="$INSTDIR\photobooth4u.exe" enable=yes profile=private,domain'
!macroend
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="photobooth4u guest photos"'
!macroend
