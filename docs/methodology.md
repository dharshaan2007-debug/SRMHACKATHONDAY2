# Multi-Hazard Risk Index Methodology

## 1. Data Pipeline

### Architecture
```
Satellite Data (GEE) → Image Processing → Geospatial Analysis → MCDM Risk Index → Static Rasters
                                                                                       ↓
                                                                              Browser loads PNGs
                                                                                       ↓
                                                              Live OSM fetch → Graph Build → Dijkstra
                                                                                       ↓
                                                                              3D Map + Dashboard
```

### Input Data Sources

| Dataset | GEE Collection ID | Resolution | Use |
|---------|-------------------|------------|-----|
| SRTM DEM | `USGS/SRTMGL1_003` | 30m | Slope, relative elevation |
| JRC Global Surface Water | `JRC/GSW1_4/GlobalSurfaceWater` | 30m | Historical water occurrence |
| Sentinel-1 GRD | `COPERNICUS/S1_GRD` | 10m | Monsoon water detection |
| CHIRPS Daily | `UCSB-CHG/CHIRPS/DAILY` | ~5km | Rainfall intensity |
| ESA WorldCover | `ESA/WorldCover/v200` | 10m | Land cover vulnerability |
| MODIS NDVI | `MODIS/061/MOD13A1` | 500m | Vegetation health |
| GHSL Population | `JRC/GHSL/P2023A/GHS_POP` | 100m | Population exposure |
| FAO GAUL | `FAO/GAUL/2015/level1`, `level2` | Admin | State/district boundaries |

## 2. Normalization

All indicators are normalized to [0, 1] using min-max scaling with percentile clipping:

```
x_normalized = clamp((x - P₂) / (P₉₈ - P₂), 0, 1)
```

Where P₂ and P₉₈ are the 2nd and 98th percentiles computed over the entire region. This reduces the impact of outliers.

## 3. Flood Hazard Index

Five contributing factors:

| Factor | Weight | Source | Notes |
|--------|--------|--------|-------|
| JRC water occurrence | 30% | JRC/GSW1_4 | Historical water frequency |
| SAR water frequency | 25% | Sentinel-1 VV | Monsoon seasons (Jun-Sep, Oct-Dec), VV < -15 dB threshold |
| CHIRPS heavy rainfall | 20% | CHIRPS daily | 95th percentile daily rainfall |
| Relative elevation (inv) | 15% | SRTM | Elevation minus local minimum (2km), inverted |
| Built-up/water fraction | 10% | ESA WorldCover | Impervious surface and water body fraction |

```
flood_hazard = Σ (wᵢ × factorᵢ)
```

## 4. Landslide Hazard Index

Four contributing factors:

| Factor | Weight | Source | Notes |
|--------|--------|--------|-------|
| Slope | 40% | SRTM | Terrain slope in degrees, normalized by 60° |
| Heavy rainfall | 25% | CHIRPS | Same as flood factor |
| Land cover vulnerability | 20% | ESA WorldCover | Bare=1.0, crop=0.7, grass=0.5, tree=0.1 |
| NDVI inverse | 15% | MODIS MOD13A1 | Low NDVI → higher landslide susceptibility |

Flat plains (slope < 2°) naturally produce near-zero landslide hazard scores.

## 5. AHP Weighting (Multi-Criteria Decision Making)

The Analytic Hierarchy Process (Saaty, 1980) is used to weight the four criteria:

### Pairwise Comparison Matrix

|  | Flood | Landslide | Slope | Exposure |
|--|-------|-----------|-------|----------|
| **Flood** | 1 | 1 | 2 | 3 |
| **Landslide** | 1 | 1 | 2 | 3 |
| **Slope** | 1/2 | 1/2 | 1 | 2 |
| **Exposure** | 1/3 | 1/3 | 1/2 | 1 |

### Computed Weights

| Criterion | Weight |
|-----------|--------|
| Flood | 35.1% |
| Landslide | 35.1% |
| Slope | 18.9% |
| Exposure | 10.9% |

**Consistency check:**
- λ_max = 4.0104
- CI = 0.0035
- CR = 0.0038 (< 0.10 ✓)

## 6. Composite Risk Index

```
R(x,y) = w_flood × flood(x,y) + w_landslide × landslide(x,y) + w_slope × slope(x,y) + w_exposure × exposure(x,y)
```

### Risk Classification

| Class | Range | Color |
|-------|-------|-------|
| Very Low | 0.0 – 0.2 | #16403a |
| Low | 0.2 – 0.4 | #2f7d5b |
| Moderate | 0.4 – 0.6 | #c8b44a |
| High | 0.6 – 0.8 | #e8833a |
| Very High | 0.8 – 1.0 | #e5484d |

## 7. Least-Risk Routing

### Edge Cost Function

For each road segment:

```
cost(e) = length_m × (1 + λ × risk(e))
```

Where:
- `length_m` = Haversine distance of the segment
- `λ` = Risk aversion factor (0 to 10, default 3)
- `risk(e)` = Composite risk sampled along the segment (midpoint + intermediate points for segments > 200m)

### Algorithm

- **Dijkstra's shortest path** with a binary min-heap
- Single source (start point), finds nearest reachable facility with lowest total cost
- Facility types: hospitals (`amenity=hospital`), shelters (`amenity=shelter|community_centre|public_building`, `emergency=assembly_point|shelter`)
- Optional: avoid very-high-risk segments (removes edges, falls back to regular routing if no path exists)

### Comparison

Two routes are computed and displayed:
1. **Shortest route** (λ = 0): pure distance minimization
2. **Least-risk route** (λ = user setting): risk-weighted cost minimization

## 8. Live Data Fetching

Roads, hospitals, shelters, and settlements are fetched live from OpenStreetMap via the Overpass API:
- Highway types: motorway, trunk, primary, secondary, tertiary, unclassified, residential
- Auto-expanding search radius: 6 km → 12 km → 20 km if no facilities found
- Multiple Overpass mirrors with failover
- IndexedDB caching for repeat queries
- Pre-cached fallback for 5 demo cities (Chennai, Coimbatore, Madurai, Udhagamandalam, Cuddalore)
- Oneway road tags respected for routing

## 9. Limitations

1. **Spatial resolution**: 500m per pixel – fine-grained urban hazard variation is not captured
2. **OSM completeness**: Rural areas may have incomplete road/facility coverage
3. **Shelter proxy**: Emergency shelters are approximated from community centres and assembly points
4. **Not an official assessment**: This tool is for research and hackathon demonstration purposes
5. **Temporal coverage**: Hazard data reflects conditions from 2020–2025; not real-time
6. **Sentinel-1 threshold**: Simple backscatter threshold (VV < -15 dB) is a proxy, not a calibrated flood detection model
7. **District boundaries**: FAO GAUL 2015 vintage may not match latest administrative boundaries
8. **Client-side routing**: Performance depends on browser capabilities; large areas may be slow
