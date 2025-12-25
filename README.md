# SondeHub Live Skew-T & Convection Height Plots
An attempt at making it easier to get the latest Skew-T plot for a particular launch site. Targeted mainly at glider pilots that want data as soon as possible after a radiosonde launch.

Also has:
- Live updating during the ascent phase of a flight
- Generation of a convection height estimate, based on intersection of a parcel with the measured temperature profile.
- URLs can be copied for a particular launch site and plot view.

Live radiosonde data from Sondehub can be missing required fields (e.g. humidity, horizontal/vertical velocity), and so this site may not work for all radiosondes. Vaisala radiosondes should be fine. Graw and iMet sondes may have problems.

This was my first experiment at developing a project using assistance from the Codex GPT model. I have very mixed feelings about using Codex, but the end-result seems functional enough.

## Contact
* Mark Jessop - <vk5qi@rfhead.net>

## Credits
* SkewT Library - https://github.com/rittels/skewt-js
* Matthew Scutter (https://skysight.io) - Prodding me to give Codex a go, and for general expertise on the calculations used here.
* Mark Newton's 'Australian Atmospheric Sounding Information' website, for information on calculating the convection height estimates - https://slash.dotat.org/atmos/help.html


## License
This work is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation; either version 2 of the License, or any later version. This work is distributed in the hope that it will be useful, but without any warranty; without even the implied warranty of merchantability or fitness for a particular purpose.  



## Possible Improvements
* Better handling of multiple launches in one synoptic period (e.g. if the first launch fails). 
* Better filtering of data received before launch. Currently this is partly filtered out based on ascent rate, but some ground data still slips through (probably due to GNSS positioning noise).
* Could possibly grab current surface temperature from open-meteo, and indicate that on the convection prediction plot?
  * e.g. https://api.open-meteo.com/v1/forecast?latitude=-34.55011&longitude=138.73604&current=temperature_2m
  * This is forecast output data, not live observations, so it's not really what we want.
* Could possibly have some overrides for particular launch sites, with info on where to pull data from (e.g. from BOM JSON files for Adelaide sites)
  * Roseworthy: https://www.bom.gov.au/fwo/IDS60801/IDS60801.95671.json
* Can we get access to a 'proper' BOM API for observation data, which would help for at least Australian launch sites?