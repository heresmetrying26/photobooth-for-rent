; Lets guests' phones on the booth Wi-Fi open their photos from this laptop
; (the app serves them on port 47777-47797). Private networks only, plus the laptop's own
; hotspot (Windows hands out 192.168.137.x there, and calls that network public).
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="photobooth4u guest photos"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="photobooth4u guest photos" dir=in action=allow program="$INSTDIR\photobooth4u.exe" enable=yes profile=private,domain'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="photobooth4u hotspot guests"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="photobooth4u hotspot guests" dir=in action=allow program="$INSTDIR\photobooth4u.exe" enable=yes profile=any remoteip=192.168.137.0/24'
  ; A GoPro's live picture (UDP video from the camera). Over USB the camera makes its own network (172.2X.1YZ.x); in Wi-Fi mode it is 10.5.5.x.
  ; Windows calls both networks public, so the rule covers every profile but only those addresses.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="photobooth4u GoPro"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="photobooth4u GoPro" dir=in action=allow program="$INSTDIR\photobooth4u.exe" enable=yes profile=any remoteip=172.20.0.0-172.29.255.255,10.5.5.0/24'
!macroend
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="photobooth4u guest photos"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="photobooth4u hotspot guests"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="photobooth4u GoPro"'
!macroend
