# Multi-Hazard Risk Index & Least-Risk Emergency Routing

**GeoImpathon 1.0 (SRM) – Day 2, Problem Statement 1.1**

Interactive multi-hazard risk mapping and emergency routing system for Tamil Nadu. Combines satellite-derived hazard data with live OpenStreetMap road networks to compute least-risk evacuation routes to the nearest hospital or shelter.

![Screenshot placeholder](docs/screenshots/.gitkeep)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  OFFLINE PIPELINE (Python + Google Earth Engine)        │
│                                                         │
│  Sentinel-1 ──┐                                        │
│  CHIRPS      ──┤── GEE Processing ── Hazard Rasters   │
│  SRTM        ──┤       ↓                ↓              │
│  WorldCover  ──┤   AHP Weighting   hazards.png        │
│  MODIS NDVI  ──┤       ↓           aux_layers.png     │
│  GHSL Pop    ──┘   Normalization   meta.json          │
│                        ↓           districts.geojson   │
│                  Static files → data/                  │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  BROWSER (Vanilla JS + MapLibre GL JS)                 │
│                                                         │
│  1. Load hazard PNGs as canvas overlays                │
│  2. User clicks → Overpass API → roads/facilities      │
│  3. Build directed graph with risk-weighted edges       │
│  4. Dijkstra (binary heap) → least-risk route          │
│  5. 3D map with terrain, route comparison              │
└─────────────────────────────────────────────────────────┘
```

## Features

- **Multi-hazard risk map**: Flood, landslide, slope, population exposure layers
- **AHP-weighted composite**: Interactive weight sliders with live map recomputation
- **Least-risk routing**: Risk-weighted Dijkstra finds safest path, not just shortest
- **Route comparison**: Side-by-side stats for shortest vs. least-risk routes
- **Live OSM data**: Roads and facilities fetched on-demand from Overpass API
- **3D terrain**: AWS Terrarium DEM with adjustable exaggeration
- **District dashboard**: Risk distribution, top-5 riskiest districts
- **Search & geolocate**: Nominatim search + browser geolocation
- **Works anywhere in Tamil Nadu**: No hardcoded demo area

## Data Sources (GEE Collection IDs)

| Dataset | Collection ID |
|---------|---------------|
| SRTM DEM | `USGS/SRTMGL1_003` |
| JRC Surface Water | `JRC/GSW1_4/GlobalSurfaceWater` |
| Sentinel-1 GRD | `COPERNICUS/S1_GRD` |
| CHIRPS Daily Rainfall | `UCSB-CHG/CHIRPS/DAILY` |
| ESA WorldCover | `ESA/WorldCover/v200` |
| MODIS NDVI | `MODIS/061/MOD13A1` |
| GHSL Population | `JRC/GHSL/P2023A/GHS_POP` |

## Run Locally

```bash
# Clone and serve
git clone https://github.com/<user>/<repo>.git
cd <repo>
python -m http.server 8000
# Open http://localhost:8000
```

No build step, no npm install – just a static file server.

## Re-run the Pipeline (GEE)

Requires Google Earth Engine authentication:

```bash
# 1. Install dependencies
pip install -r pipeline/requirements.txt

# 2. Authenticate
earthengine authenticate --project=quiet-branch-510205-h9

# 3. Run pipeline
python pipeline/01_gee_hazards.py --region tamil_nadu
python pipeline/02_district_stats.py --region tamil_nadu
python pipeline/03_cache_demo_osm.py
```

## Add a New State (Region Pack)

1. Add the state config to `pipeline/config.py` → `REGIONS` dict:
   ```python
   "kerala": {
       "id": "kerala",
       "name": "Kerala",
       "bbox": [74.8, 8.2, 77.4, 12.8],
       "gaul_name": "Kerala",
       "scale_m": 500,
       "fallback_scale_m": 1000,
       "tile_deg": 1.0,
       "crs": "EPSG:4326",
       "output_crs": "EPSG:4326",
   }
   ```

2. Run the pipeline:
   ```bash
   python pipeline/01_gee_hazards.py --region kerala
   python pipeline/02_district_stats.py --region kerala
   ```

3. Add the region to `data/regions.json`:
   ```json
   {
     "id": "kerala",
     "name": "Kerala",
     "bbox": [74.8, 8.2, 77.4, 12.8],
     "path": "data/kerala",
     "status": "ready"
   }
   ```

4. No app code changes needed.

## Deploy on GitHub Pages

1. Push to a public GitHub repository
2. Go to Settings → Pages
3. Deploy from branch → `main` / root (`/`)
4. The `.nojekyll` file is already included

## Limitations

- 500m spatial resolution – fine-grained urban variation not captured
- OSM road/facility data may be incomplete in rural areas
- Shelters approximated from community centres and assembly points
- Not an official hazard assessment – for research/hackathon use
- Sentinel-1 water detection uses simple VV threshold, not a calibrated model
- Client-side routing performance depends on browser and network

## Methodology

See [docs/methodology.md](docs/methodology.md) for formulas, AHP matrix, normalization, edge cost function, and full data source details.

## License

MIT
