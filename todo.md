# Music Player: Remove Embed, Fix Playback, Professional UI

## Tasks
- [ ] Redesign CSS: hide embed iframe completely (audio-only), redesign player card to be ultra-professional and non-cartoony
- [ ] Redesign HTML structure: remove visible embed container from the card layout, keep hidden iframe for audio
- [ ] Load Spotify iFrame API script (https://open.spotify.com/embed/iframe-api/v1) + onSpotifyIframeApiReady
- [ ] Load YouTube IFrame API script (https://www.youtube.com/iframe_api) + onYouTubeIframeAPIReady
- [ ] Rewrite setupPlatformControls to use official APIs (Spotify EmbedController, YouTube YT.Player, SoundCloud Widget)
- [ ] Rewrite togglePlay/toggleLoop/restart/skip10/setVolume/toggleMute to use official APIs
- [ ] Rewrite createYTPlayer to create player in hidden container
- [ ] Update load() to inject hidden iframe and wire up APIs
- [ ] Verify index.html JS syntax (node -c)
- [ ] Commit, push, verify Render deploy
