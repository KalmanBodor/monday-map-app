import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import './App.css';
import mondaySdk from "monday-sdk-js";

const monday = mondaySdk();
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

function App() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const markerCoords = useRef({});
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);

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
	  const boardId = res.data.boardId;
	  if (!boardId) return;

	  try {
		const query = `
		  query {
			boards(ids: ${boardId}) {
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
		  }
		`;

		const response = await monday.api(query);
		console.log(response);
		let items = response?.data?.boards?.[0]?.items_page?.items || [];
		setItems(items);

		const map = mapRef.current;

		async function geocode(address) {
		  const resp = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${mapboxgl.accessToken}`);
		  const data = await resp.json();
		  return data.features[0]?.center;
		}

		async function plotPins() {
		  for (const item of items) {
			const addrCol = item.column_values.find(col => col.column.title.match(/address/i));
			item['address'] = addrCol?.text;

			const status = item.column_values.find(col => col.column.title.match(/status/i))?.[0];

			if ( status ) {
				if ( status.value && status.column.settings_str ) {
					let statusMeta = {};
					let statusParsed = {};
					try {
						statusMeta = JSON.parse(status.column.settings_str);
						statusParsed = JSON.parse(status.value);
					} catch (e) {}

					if ( statusMeta && Object.keys(statusMeta) && statusParsed && Object.keys(statusParsed) ) {
						status['statusColor'] = statusMeta.labels_colors[ statusParsed.index ];
						status['statusStyle'] = { color: col.statusColor };
					}
				}
			}

			if (!addrCol) continue;

			const coords = await geocode(item.address);
			if (!coords) continue;

			markerCoords.current[item.id] = coords;

			let marker = new mapboxgl.Marker({ color: status.statusColor ? status.statusColor : "orange" })
			  .setLngLat(coords)
			  .addTo(map);

			const addrPop = new mapboxgl.Popup({ closeButton: false, closeOnClick: false })
				.setHTML(
					`<div class="pin-pop">
						<div>${item.address}</div>
						<div>${item.name}</div>
					</div>`
				);

			marker.getElement().addEventListener('mouseenter', () => {
				addrPop.setLngLat(marker.getLngLat()).addTo(map);
			});

			marker.getElement().addEventListener('mouseleave', () => {
				addrPop.remove();
			});
		  }
		}

		if (map.loaded()) {
		  plotPins();
		} else {
		  map.on('load', plotPins);
		}

		setLoading(false);
	  } catch (err) {
		console.error("Error fetching board data:", err);
	  }
	});
  }, []);

  const flyToItem = (id) => {
	const coords = markerCoords.current[id];
	if (coords && mapRef.current) {
	  mapRef.current.flyTo({ center: coords, zoom: 15 });
	}
  };

  return (
	<div id="root">
	 	<div className={`sidebar ${!sidebarOpen ? 'closed' : ''}`}>
			<button className="sbr-toggle-btn list-toggle" onClick={() => setSidebarOpen(false)}>
				Hide Properties
			</button>
			<div className="cards-container">
				{items.map(item => {
					return (
						<div key={item.id} onClick={() => flyToItem(item.id)} className="card">
							<div className="card-addr">{item.address}</div>
							<div>{item.name}</div>
							<ul className="item-cols">
								{item.column_values.map((col, idx) => (
									<li key={idx}>
										<div className="col-label">{col.column.title}</div>
										<div className="col-val" style="{col.statusStyle}">{col.text}</div>
									</li>
								))}
							</ul>
						</div>
					);
				})}
			</div>
		</div>

		{!sidebarOpen && (
			<button className="sbr-toggle-btn sidebar-toggle" onClick={() => setSidebarOpen(true)}>
				Show Properties
			</button>
		)}
	  	<div ref={mapContainer} className="map-container" />
	  		{loading && <div style={{ position: 'absolute', zIndex: 1, padding: 10 }}>Loading map data...</div>}
		</div>
  );
}

export default App;
