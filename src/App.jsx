import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import mondaySdk from "monday-sdk-js";
import Modal from 'react-modal';
import './App.css';
import photoPlaceholder from './assets/city_skyline.svg';

const monday = mondaySdk();
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

function App() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const markerCoords = useRef({});
  const [items, setItems] = useState([]);
  const [boards, setBoards] = useState([]);
  const [selectedBoard, setSelectedBoard] = useState("current");
  const [allItemsRaw, setAllItemsRaw] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [hoveredItem, setHoveredItem] = useState(null);
  const [selectedItemIds, setSelectedItemIds] = useState(new Set());
  const [galleryImages, setGalleryImages] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  Modal.setAppElement('#root');

  useEffect(() => {
    mapRef.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v11',
      center: [-73.935242, 40.730610],
      zoom: 10,
    });

    window.map = mapRef.current;
    window.mapboxgl = mapboxgl;

    return () => mapRef.current?.remove();
  }, []);

    useEffect(() => {
    monday.listen("context", async (res) => {
      const currentBoardId = res.data.boardId;
      if (!currentBoardId) return;

      try {
        const boardsRes = await monday.api(`query { boards(limit: 20) { id name } }`);
        setBoards([{ id: "current", name: "Current" }, ...boardsRes.data.boards]);
        fetchBoardData(currentBoardId, true);
      } catch (err) {
        console.error("Board list fetch failed:", err);
      }
    });
  }, []);

  async function fetchBoardData(boardId, isCurrent = false) {
    setLoading(true);
    const boardIds = isCurrent
      ? [boardId]
      : selectedBoard === "all"
      ? boards.filter(b => b.id !== "current").map(b => b.id)
      : [selectedBoard];

    let allItems = [];
    for (let id of boardIds) {
      const query = `
        query {
          boards(ids: ${id}) {
            items_page {
              items {
                id
                name
                column_values {
                  id
                  value
                  text
                  column {
                    title
                    settings_str
                  }
                }
              }
            }
          }
        }`;
      try {
        const response = await monday.api(query);
        const boardItems = response?.data?.boards?.[0]?.items_page?.items || [];
        allItems.push(...boardItems);
      } catch (e) {
        console.warn("Failed loading board", id);
      }
    }

    const parsedItems = await Promise.all(allItems.map(item => processItem(item)));
    setItems(parsedItems);
    setAllItemsRaw(parsedItems);
    plotPins(parsedItems);
    setLoading(false);
  }

  async function geocodeAddress(address) {
    const resp = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${mapboxgl.accessToken}`);
    const data = await resp.json();
    return data.features[0] || null;
  }

    async function processItem(item) {
    const addrCol = item.column_values.find(col => col.column.title.match(/address/i));
    const status = item.column_values.find(col => col.column.title.match(/status/i));
    let statusColor = null;

    if (status?.value && status.column?.settings_str) {
      try {
        const meta = JSON.parse(status.column.settings_str);
        const val = JSON.parse(status.value);
        statusColor = meta.labels_colors[val.index]?.color || 'orange';
        status.statusColor = statusColor;
        item.statusColor = statusColor;
      } catch (e) {}
    }

    const imageUrls = [];
    item.column_values.forEach(col => {
      if (col.id.startsWith("file_")) {
        col.skipDisplayFile = true;
        if (col.value && col.text) {
          try {
            const fileObj = JSON.parse(col.value);
            const files = fileObj.files || [];
            files.forEach(f => {
              if (f.isImage === "true") {
                let listSplit = col.text.split(/,\s*/) || [];
                let urlBase = listSplit[0].match(/https:\/\/.*.monday.com\/protected_static\/\d+\/resources\//);
                urlBase = urlBase?.[0];
                if (urlBase) imageUrls.push(`${urlBase}/${f.assetId}/${f.name}`);
              }
            });
          } catch (e) {
            console.warn("Error parsing file column:", e);
          }
        }
      } else {
        col.skipDisplayFile = false;
      }
    });

    item.images = imageUrls;
    item.thumb = imageUrls[0] || null;

    if (addrCol?.text) {
      const geo = await geocodeAddress(addrCol.text);
      item.coords = geo?.center ? geo.center.reverse().join(',') : '';
      item.driveLink = isIOS()
        ? `http://maps.apple.com/?daddr=${item.coords}`
        : `https://www.google.com/maps/dir/?api=1&destination=${item.coords}`;
      item.geoParsedAddress = geo?.matching_place_name || addrCol.text;

      // Neighborhood/City context
      const ctx = geo?.context || [];
      const nhood = ctx.find(c => c.id.startsWith("neighborhood"))?.text;
      const locality = ctx.find(c => c.id.startsWith("locality"))?.text;
      item.nhoodCity = nhood ? `${nhood}, ${locality || ''}` : locality || '';
      item.origAddrLabel = addrCol.column.title;
      item.origAddrValue = addrCol.text;
    }

    return item;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  async function plotPins(items) {
    const map = mapRef.current;
    items.forEach(item => {
      if (!item.coords) return;
      const coords = item.coords.split(',').map(Number).reverse();
      const marker = new mapboxgl.Marker({ color: item.statusColor || 'orange' })
        .setLngLat(coords)
        .addTo(map);

      markerCoords.current[item.id] = coords;
      marker.getElement().addEventListener('mouseenter', () => {
        setHoveredItem({ id: item.id, name: item.name, address: item.geoParsedAddress, coords });
      });
      marker.getElement().addEventListener('mouseleave', () => setHoveredItem(null));
    });
  }

    const toggleItemSelection = (id) => {
    const copy = new Set(selectedItemIds);
    copy.has(id) ? copy.delete(id) : copy.add(id);
    setSelectedItemIds(copy);
  };

  const selectedItems = items.filter(i => selectedItemIds.has(i.id));

  const handleRoute = () => {
    if (selectedItems.length === 0) {
      alert("Please select at least one property.");
      return;
    }
    const coords = selectedItems.map(i => i.coords).join('/');
    const base = isIOS()
      ? `http://maps.apple.com/?daddr=${selectedItems[0].coords}`
      : `https://www.google.com/maps/dir/${coords}`;
    window.open(base, '_blank');
  };

  const handlePrint = () => {
    if (selectedItems.length === 0) {
      alert("Please select at least one property.");
      return;
    }
    window.print();
  };
  return (
    <div id="root">
      <div className={`sidebar ${!sidebarOpen ? 'closed' : ''}`}>
        <button className="sbr-toggle-btn list-toggle" onClick={() => setSidebarOpen(false)}>
          &laquo; Hide Properties
        </button>

        <div className="sidebar-controls">
          <label>
            Board:
            <select
              value={selectedBoard}
              onChange={(e) => {
                setSelectedBoard(e.target.value);
                fetchBoardData(e.target.value === "current" ? boards[0].id : e.target.value);
              }}
            >
              <option value="current">Current</option>
              <option value="all">All Boards</option>
              {boards
                .filter(b => b.id !== "current")
                .map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        </div>

        <div className="action-buttons">
          <button
            onClick={handleRoute}
            disabled={selectedItemIds.size === 0}
            title="Select at least one item to plan a route"
          >
            🚗 Plan Route
          </button>
          <button
            onClick={handlePrint}
            disabled={selectedItemIds.size === 0}
            title="Select at least one item to generate PDF"
          >
            🖨️ Export PDF
          </button>
        </div>

        <div className="cards-container">
          {items.map(item => (
            <div
              key={item.id}
              onClick={() => {
                setSelectedItemId(item.id);
                flyToItem(item.id);
              }}
              className={`card ${selectedItemId === item.id ? 'selected' : ''}`}
            >
              <input
                type="checkbox"
                checked={selectedItemIds.has(item.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggleItemSelection(item.id)}
              />

              <div className="thumb-wrapper">
                {item.thumb ? (
                  <img
                    src={item.thumb}
                    alt="Thumbnail"
                    className="card-thumb"
                    onClick={(e) => {
                      e.stopPropagation();
                      setGalleryImages(item.images);
                      setCurrentIndex(0);
                    }}
                  />
                ) : (
                  <div className="card-thumb no-photo-tooltip">
                    <img src={photoPlaceholder} alt="No photo" className="thumb-img" />
                    <div className="tooltip">
                      Add a “Files” column and upload images to display a photo gallery here.
                    </div>
                  </div>
                )}
              </div>

              <div className="card-addr">
                <span>{item.geoParsedAddress || item.address}</span>
                <a
                  href={item.driveLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="map-link"
                  title="Get Directions"
                >
                  Drive there
                </a>
              </div>

              <div className="card-name">{item.name}</div>

              <ul className="item-cols">
                {item.origAddrLabel && (
                  <li>
                    <div className="col-label">{item.origAddrLabel}</div>
                    <div className="col-val">{item.origAddrValue}</div>
                  </li>
                )}
                {item.nhoodCity && (
                  <li>
                    <div className="col-label">Nhood/City</div>
                    <div className="col-val">{item.nhoodCity}</div>
                  </li>
                )}
                {item.column_values.map((col, idx) =>
                  !col.skipDisplayFile && (
                    <li key={idx}>
                      <div className="col-label">{col.column.title}</div>
                      <div
                        className="col-val"
                        style={{ ...(col.statusColor && { color: col.statusColor }) }}
                      >
                        {autoFormat(col.text)}
                      </div>
                    </li>
                  )
                )}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {!sidebarOpen && (
        <button className="sbr-toggle-btn sidebar-toggle" onClick={() => setSidebarOpen(true)}>
          Show Properties &raquo;
        </button>
      )}

      <div ref={mapContainer} className="map-container">
        {loading && <div style={{ position: 'absolute', zIndex: 1, padding: 10 }}>Loading map data...</div>}
      </div>

      {hoveredItem && mapRef.current && (
        <div
          className="pin-tooltip show"
          style={{
            position: 'absolute',
            left: `${mapRef.current.project(hoveredItem.coords).x}px`,
            top: `${mapRef.current.project(hoveredItem.coords).y - 40}px`,
            pointerEvents: 'none',
          }}
        >
          <div className="tooltip-content">
            <div className="tooltip-address">{hoveredItem.address}</div>
            <div className="tooltip-name">{hoveredItem.name}</div>
          </div>
        </div>
      )}

      <Modal
        isOpen={galleryImages.length > 0}
        onRequestClose={() => setGalleryImages([])}
        className="modal"
        overlayClassName="overlay"
        contentLabel="Image Gallery"
      >
        {galleryImages.length > 0 && (
          <div className="modal-content">
            <button className="close-btn" onClick={() => setGalleryImages([])}>×</button>
            <button className="nav-btn left" onClick={() => setCurrentIndex(i => (i - 1 + galleryImages.length) % galleryImages.length)}>‹</button>
            <img src={galleryImages[currentIndex]} alt="Gallery" className="gallery-image-large" />
            <button className="nav-btn right" onClick={() => setCurrentIndex(i => (i + 1) % galleryImages.length)}>›</button>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default App;