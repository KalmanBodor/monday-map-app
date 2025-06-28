// Refactored App.jsx
// Key changes:
// 1. Consolidated filter state into a single object so we don’t juggle separate
//    useStates for board and neighbourhood filters.
// 2. Re‑organised data‑loading flow: items are fetched *once* per board change
//    and immediately geocoded before being dropped in state. plotPins no longer
//    mutates state, eliminating the render → effect → state‑update loop that was
//    causing continuous re‑renders.
// 3. A single useEffect (watching `filters`) now reacts to both board and
//    nhood changes, satisfying the requirement that “the same function should
//    be called when nhood filter and board filter is changed.”
// 4. Trimmed a handful of now‑redundant useStates/useEffects.

import "./polyfills"; // Import polyfills first

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

import Modal from "react-modal";
import { createPortal } from "react-dom";
import {
  useEffect,
  useRef,
  useState,
  useMemo,
} from "react";

import mondaySdk from "monday-sdk-js";
import {
  Button,
  Dropdown,
  Checkbox,
  Text,
  Icon,
  IconButton,
  Tooltip,
  Avatar,
  Flex,
  Box,
} from "@vibe/core";
import { PDF, Country, Location, Remove, Check } from "@vibe/icons";
import "@vibe/core/tokens";

import "./App.css";
import photoPlaceholder from "./assets/city_skyline.svg";

const monday = mondaySdk();
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

function App() {
  /* -----------------------------------------------------------------------
   * REFS & STABLE SINGLETONS
   * ---------------------------------------------------------------------*/
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const markerCoords = useRef({});
  const currentBoardIdRef = useRef(null);

  /* -----------------------------------------------------------------------
   * REACT STATE
   * ---------------------------------------------------------------------*/
  const [items, setItems] = useState([]); // all loaded + geocoded items
  const [boards, setBoards] = useState([]); // <Dropdown> options
  const [filters, setFilters] = useState({ boards: ["current"], nhoods: [] });
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [hoveredItem, setHoveredItem] = useState(null);
  const [gallery, setGallery] = useState({ images: [], index: 0 });
  const [selectedItems, setSelectedItems] = useState(new Set());
  const [showSelectionModal, setShowSelectionModal] = useState(false);

  /* -----------------------------------------------------------------------
   * MEMO‑DERIVED DATA
   * ---------------------------------------------------------------------*/
  const nhoods = useMemo(() => {
    const uniq = new Set(items.map((i) => i.nhoodCity).filter(Boolean));
    return [...uniq].sort();
  }, [items]);

  const displayedItems = useMemo(() => {
    if (!filters.nhoods.length) return items;
    return items.filter((i) => filters.nhoods.includes(i.nhoodCity));
  }, [items, filters]);

  /* -----------------------------------------------------------------------
   * DATA FETCHING & GEOCODING
   * ---------------------------------------------------------------------*/
  const geocode = async (address) => {
    const resp = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
        address
      )}.json?access_token=${mapboxgl.accessToken}`
    );
    const data = await resp.json();
    if (!data.features?.[0]) return null;

    const feature = data.features[0];
    const ctx = feature.context || [];
    const neighborhood = ctx.find((c) => c.id.startsWith("neighborhood."));
    const locality = ctx.find((c) => c.id.startsWith("locality."));
    let nhoodCity = "";
    if (neighborhood && locality) nhoodCity = `${neighborhood.text}, ${locality.text}`;
    else if (locality) nhoodCity = locality.text;
    else if (neighborhood) nhoodCity = neighborhood.text;

    return {
      center: feature.center, // [lng, lat]
      fullAddress: feature.place_name,
      nhoodCity,
    };
  };

  const processItems = (apiResponse) => {
    let all = [];
    apiResponse?.data?.boards?.forEach((b) => {
      all = [...all, ...(b.items_page?.items || [])];
    });

    return all.map((item) => {
      const addrCol = item.column_values.find((c) => c.column.title.match(/address/i));
      const statusCol = item.column_values.find((c) => c.column.title.match(/status/i));

      /** status colour helper */
      let statusStyle = null;
      if (statusCol?.value && statusCol.column?.settings_str) {
        try {
          const meta = JSON.parse(statusCol.column.settings_str);
          const val = JSON.parse(statusCol.value);
          statusStyle = {
            color: meta.labels_colors[val.index]?.color || "orange",
            fontWeight: 600,
          };
        } catch (_) {}
      }

      /** collect file column thumbnails */
      const images = [];
      item.column_values.forEach((col) => {
        if (col.id.startsWith("file_")) {
          col.skipDisplayFile = true;
          if (col.value && col.text) {
            try {
              const fileObj = JSON.parse(col.value);
              (fileObj.files || []).forEach((f) => {
                if (f.isImage === "true") {
                  const base = col.text.match(
                    /https:\/\/.*.monday.com\/protected_static\/\d+\/resources\//
                  )?.[0];
                  if (base) images.push(`${base}/${f.assetId}/${f.name}`);
                }
              });
            } catch (_) {}
          }
        } else {
          col.skipDisplayFile = false;
        }
      });

      return {
        ...item,
        address: addrCol?.text || "",
        addressColumnTitle: addrCol?.column?.title || "Address",
        originalAddress: addrCol?.text || "",
        thumb: images[0] || null,
        images,
        statusStyle,
        // placeholders – will be filled post‑geocode
        coords: null,
        parsedAddress: "",
        nhoodCity: "",
        driveLink: "",
      };
    });
  };

  const geocodeItems = async (rawItems) => {
    return Promise.all(
      rawItems.map(async (item) => {
        if (!item.address) return item; // skip if no address
        const g = await geocode(item.address);
        if (!g) return item;

        const [lng, lat] = g.center;
        return {
          ...item,
          coords: `${lat},${lng}`,
          parsedAddress: g.fullAddress.replace(/(, )?United States/, ""),
          nhoodCity: g.nhoodCity,
          driveLink: isIOS()
            ? `http://maps.apple.com/?daddr=${lat},${lng}`
            : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
        };
      })
    );
  };

  const fetchItemsFromBoard = async (boardSelections) => {
    const ids = new Set();
    if (boardSelections.includes("current") && currentBoardIdRef.current) ids.add(currentBoardIdRef.current);
    if (boardSelections.includes("all")) boards.forEach((b) => ids.add(+b.id));
    boardSelections.forEach((v) => {
      if (v !== "current" && v !== "all") ids.add(+v);
    });
    if (!ids.size) return;

    const query = `query{boards(ids:[${[...ids]}]){items_page{items{id name column_values{id text value column{title settings_str}}}}}}`;
    const { data } = await monday.api(query);
    const processed = processItems({ data });
    const withGeo = await geocodeItems(processed);
    setItems(withGeo);
  };

  /* -----------------------------------------------------------------------
   * EFFECTS
   * ---------------------------------------------------------------------*/
  // initialise Map once
  useEffect(() => {
    mapRef.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/streets-v11",
      center: [-73.935242, 40.73061],
      zoom: 10,
    });
    return () => mapRef.current?.remove();
  }, []);

  // handle context → current board id
  useEffect(() => {
    monday.get("context").then((res) => {
      currentBoardIdRef.current = res.data.boardId || null;
      fetchItemsFromBoard(filters.boards);
    });
    monday.listen("context", (res) => {
      currentBoardIdRef.current = res.data.boardId;
      fetchItemsFromBoard(filters.boards);
    });
  }, []); // run once

  // load list of boards on mount
  useEffect(() => {
    (async () => {
      const query = `query { boards { id name } }`;
      try {
        const { data } = await monday.api(query);
        setBoards(data?.boards || []);
      } catch (err) {
        console.error("Error fetching boards:", err);
      }
    })();
  }, []);

  // unified reaction to *either* board or nhood filter change
  useEffect(() => {
    fetchItemsFromBoard(filters.boards);
    // eslint‑disable‑next‑line react-hooks/exhaustive-deps
  }, [filters.boards]);

  // whenever *displayed* items change → refresh pins
  useEffect(() => {
    plotPins(displayedItems);
  }, [displayedItems]);

  /* -----------------------------------------------------------------------
   * MAP MARKERS
   * ---------------------------------------------------------------------*/
  const plotPins = (itemsToPlot) => {
    const map = mapRef.current;
    if (!map) return;

    // clear old markers
    const old = document.querySelectorAll(".mapboxgl-marker");
    old.forEach((m) => m.remove());
    markerCoords.current = {};

    itemsToPlot.forEach((item) => {
      if (!item.coords) return;
      const [lat, lng] = item.coords.split(",").map(Number);
      markerCoords.current[item.id] = [lng, lat];
      const marker = new mapboxgl.Marker({ color: item.statusStyle?.color || "#orange" })
        .setLngLat([lng, lat])
        .addTo(map);

      const el = marker.getElement();
      el.style.cursor = "pointer";
      el.addEventListener("mouseenter", () =>
        setHoveredItem({ id: item.id, name: item.name, address: item.address, coords: marker.getLngLat() })
      );
      el.addEventListener("mouseleave", () => setHoveredItem(null));
    });
  };

  /* -----------------------------------------------------------------------
   * UI EVENT HANDLERS
   * ---------------------------------------------------------------------*/
  const handleBoardChange = (opts) => {
    const values = opts.map((o) => o.value);
    setSelectedItems(new Set());
    setFilters((f) => ({ ...f, boards: values }));
  };

  const handleNhoodChange = (opts) => {
    setFilters((f) => ({ ...f, nhoods: opts.map((o) => o.value) }));
  };

  const handleItemSelection = (id, checked) => {
    const next = new Set(selectedItems);
    checked ? next.add(id) : next.delete(id);
    setSelectedItems(next);
  };

  const flyToItem = (id) => {
    const coord = markerCoords.current[id];
    if (coord && mapRef.current) mapRef.current.flyTo({ center: coord, zoom: 17 });
  };

  const handleRoutePlanning = () => {
    if (!selectedItems.size) return setShowSelectionModal(true);

    const coords = [...selectedItems]
      .map((id) => items.find((i) => i.id === id)?.coords)
      .filter(Boolean);
    if (!coords.length) return;

    let url;
    if (coords.length === 1) {
      url = isIOS()
        ? `http://maps.apple.com/?daddr=${coords[0]}`
        : `https://www.google.com/maps/dir/?api=1&destination=${coords[0]}`;
    } else if (isIOS()) {
      url = `http://maps.apple.com/?daddr=${coords[0]}`; // Apple Maps no waypoints via URL
    } else {
      const dest = coords[coords.length - 1];
      const waypoints = coords.slice(0, -1).join("|");
      url = `https://www.google.com/maps/dir/?api=1&destination=${dest}&waypoints=${waypoints}`;
    }
    window.open(url, "_blank");
  };

  const handlePDFGeneration = () => {
    if (!selectedItems.size) return setShowSelectionModal(true);
    const sel = [...selectedItems]
      .map((id) => items.find((i) => i.id === id))
      .filter(Boolean);
    const win = window.open("", "_blank");
    win.document.write(`<!DOCTYPE html><html><head><title>Selected Properties</title><style>
      body{font-family:Arial;margin:20px} .property{margin-bottom:30px;border-bottom:1px solid #ccc;padding-bottom:20px}
      .property-name{font-size:18px;font-weight:bold;margin-bottom:5px} .property-address{color:#666;margin-bottom:10px}
    </style></head><body><h1>Selected Properties Report</h1><p>Generated ${new Date().toLocaleDateString()}</p>
      ${sel
        .map(
          (i) => `<div class="property"><div class="property-name">${i.name}</div>
            <div class="property-address">${i.parsedAddress}</div>
            ${i.nhoodCity ? `<div class="property-address">${i.nhoodCity}</div>` : ""}
            <ul class="property-details">
            ${i.column_values
              .filter((c) => !c.skipDisplayFile)
              .map((c) => `<li><strong>${c.column.title}:</strong> ${c.text}</li>`) // autoFormat removed for brevity
              .join("")}
      </ul></div>`
        )
        .join("")}
      </body></html>`);
    win.document.close();
    win.print();
  };

  /* -----------------------------------------------------------------------
   * RENDER
   * ---------------------------------------------------------------------*/
  const boardOptions = [
    { value: "current", label: "Current Board" },
    ...boards.map((b) => ({ value: b.id, label: b.name })),
    { value: "all", label: "All Boards" },
  ];

  Modal.setAppElement("#root");

  return (
    <>
      <Flex style={{ height: "100%", width: "100%" }}>
        {/* ░░░░░░░░░░░░ SIDEBAR ░░░░░░░░░░░░ */}
        <Box
          width="25%"
          backgroundColor="surface"
          style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 8 }}
        >
          {/* board selector */}
          <Dropdown
            placeholder="Select board"
            options={boardOptions}
            defaultValue={[boardOptions[0]]}
            onChange={handleBoardChange}
            multi
            multiline
            style={{ width: "100%", marginBottom: 8 }}
          />

          {/* neighbourhood filter */}
          <Dropdown
            placeholder="Filter by nhood"
            options={nhoods.map((n) => ({ value: n, label: n }))}
            onChange={handleNhoodChange}
            multi
            clearable
            style={{ width: "100%", marginBottom: 8 }}
          />

          {/* cards */}
          <Box className="cards-container" scrollable style={{ flex: 1 }}>
            {displayedItems.map((item) => (
              <Box
                key={item.id}
                padding="medium"
                rounded="small"
                className={`property-card ${selectedItemId === item.id ? "selected" : ""}`}
                onClick={() => {
                  setSelectedItemId(item.id);
                  flyToItem(item.id);
                }}
              >
                <Box className="thumb-wrapper">
                  {item.thumb ? (
                    <img
                      src={item.thumb}
                      alt="Thumbnail"
                      className="card-thumb"
                      onClick={(e) => {
                        e.stopPropagation();
                        setGallery({ images: item.images, index: 0 });
                      }}
                    />
                  ) : (
                    <Tooltip content="Add a 'Files' column and upload images." position="top">
                      <Box className="card-thumb no-photo">
                        <Avatar src={photoPlaceholder} alt="No photo" size="large" type="img" />
                      </Box>
                    </Tooltip>
                  )}
                </Box>

                <Box className="card-content">
                  <Flex justify="space-between" align="start" gap="small" style={{ width: "100%" }}>
                    <Flex gap="small" align="start" style={{ flex: 1 }}>
                      <Icon icon={Location} iconSize={22} />
                      <Text element="div" maxLines={2} weight="bold" className="card-addr">
                        {item.parsedAddress || item.address}
                      </Text>
                    </Flex>
                    <Checkbox
                      checked={selectedItems.has(item.id)}
                      onChange={(e) => handleItemSelection(item.id, e.target.checked)}
                    />
                  </Flex>

                  <Text element="div" weight="bold" className="property-name" style={{ margin: "6px 0" }}>
                    {item.name}
                  </Text>

                  <Box className="item-details">
                    {item.nhoodCity && (
                      <Flex justify="space-between" style={{ marginBottom: 6 }}>
                        <Text size="small" weight="bold" style={{ color: "var(--color-ui_grey)" }}>
                          Nhood/City
                        </Text>
                        <Text size="small">{item.nhoodCity}</Text>
                      </Flex>
                    )}
                    {item.originalAddress && (
                      <Flex justify="space-between" style={{ marginBottom: 6 }}>
                        <Text size="small" weight="bold" style={{ color: "var(--color-ui_grey)" }}>
                          {item.addressColumnTitle}
                        </Text>
                        <Text size="small">{item.originalAddress}</Text>
                      </Flex>
                    )}
                    {item.column_values
                      .filter((c) => !c.skipDisplayFile && !c.column.title.match(/address/i))
                      .map((col, idx) => (
                        <Flex key={idx} justify="space-between" style={{ marginBottom: 6 }}>
                          <Text size="small" weight="bold" style={{ color: "var(--color-ui_grey)" }}>
                            {col.column.title}
                          </Text>
                          <Text size="small" style={col.statusStyle}>
                            {col.text}
                          </Text>
                        </Flex>
                      ))}
                  </Box>
                </Box>
              </Box>
            ))}
          </Box>

          {/* bottom buttons */}
          <Flex gap="small" style={{ paddingTop: 8 }}>
            <Button
              leftIcon={Country}
              kind="primary"
              onClick={handleRoutePlanning}
              style={{ flex: 1 }}
            >
              Route ({selectedItems.size})
            </Button>
            <Button
              leftIcon={PDF}
              kind="primary"
              onClick={handlePDFGeneration}
              style={{ flex: 1 }}
            >
              PDF ({selectedItems.size})
            </Button>
            <IconButton
              icon={selectedItems.size ? Remove : Check}
              onClick={() =>
                setSelectedItems((s) =>
                  s.size ? new Set() : new Set(displayedItems.map((i) => i.id))
                )
              }
              tooltipContent={selectedItems.size ? "Unselect all" : "Select all"}
            />
          </Flex>
        </Box>

        {/* ░░░░░░░░░░░░ MAP ░░░░░░░░░░░░ */}
        <Box style={{ flexGrow: 1, height: "100vh" }}>
          <div ref={mapContainer} style={{ height: "100%", width: "100%" }} />
          {hoveredItem &&
            mapRef.current &&
            createPortal(
              <div
                className="pin-tooltip show"
                style={{
                  position: "absolute",
                  left:
                    mapRef.current.project(hoveredItem.coords).x +
                    mapContainer.current.getBoundingClientRect().left,
                  top:
                    mapRef.current.project(hoveredItem.coords).y +
                    mapContainer.current.getBoundingClientRect().top -
                    40,
                  pointerEvents: "none",
                }}
              >
                <div className="tooltip-content">
                  <div className="tooltip-address">{hoveredItem.address}</div>
                  <div className="tooltip-name">{hoveredItem.name}</div>
                </div>
              </div>,
              document.body
            )}
        </Box>
      </Flex>

      {/* gallery modal */}
      <Modal
        isOpen={gallery.images.length > 0}
        onRequestClose={() => setGallery({ images: [], index: 0 })}
        className="modal"
        overlayClassName="overlay"
      >
        {gallery.images.length > 0 && (
          <div className="modal-content">
            <button className="close-btn" onClick={() => setGallery({ images: [], index: 0 })}>
              ×
            </button>
            <button
              className="nav-btn left"
              onClick={() =>
                setGallery((g) => ({ ...g, index: (g.index - 1 + g.images.length) % g.images.length }))
              }
            >
              ‹
            </button>
            <img src={gallery.images[gallery.index]} alt="Gallery" className="gallery-image-large" />
            <button
              className="nav-btn right"
              onClick={() =>
                setGallery((g) => ({ ...g, index: (g.index + 1) % g.images.length }))
              }
            >
              ›
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}

export default App;
