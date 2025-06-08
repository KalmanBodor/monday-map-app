import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import mondaySdk from "monday-sdk-js";
import Modal from 'react-modal';
import './App.css';

const monday = mondaySdk();
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

function App() {
	const mapContainer = useRef(null);
	const mapRef = useRef(null);
	const markerCoords = useRef({});
	const [items, setItems] = useState([]);
	const [loading, setLoading] = useState(true);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [selectedItemId, setSelectedItemId] = useState(null);
	const [hoveredItem, setHoveredItem] = useState(null);
	const [galleryImages, setGalleryImages] = useState([]);
	const [currentIndex, setCurrentIndex] = useState(0);

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

	Modal.setAppElement('#root');

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

				items = items.map(item => {
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
						if (col.value && col.value.files && col.text) {
							try {
								let urlBase = col.text.match(/https:\/\/.*.monday.com\/protected_static\/\d+\/resources\//);
								if (urlBase) {
									urlBase = urlBase[0];
									const fileObj = JSON.parse(col.value);
									const files = fileObj.files || [];
									files.forEach(f => {
										if (f.isImage === "true") {
											imageUrls.push(`${urlBase}/${f.assetId}/${f.name}`);
										}
									});
								}
							} catch (e) {
								console.warn("Error parsing file column:", e);
							}
						}
					});
					item.images = imageUrls;
					item.thumb = imageUrls[0] || null;

					return {
						...item,
						address: addrCol?.text || '',
					};
				});

				setItems(items);

				const map = mapRef.current;

				async function geocode(address) {
					const resp = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${mapboxgl.accessToken}`);
					const data = await resp.json();
					return data.features[0]?.center;
				}

				async function plotPins() {
					for (const item of items) {
						if (!item.address) continue;

						const coords = await geocode(item.address);
						if (!coords) continue;

						markerCoords.current[item.id] = coords;
						item.coords = [ coords[1], coords[0] ].join(',');
						item.driveLink = isIOS()
							? `http://maps.apple.com/?daddr=${item.coords}`
							: `https://www.google.com/maps/dir/?api=1&destination=${item.coords}`;

						let marker = new mapboxgl.Marker(
								{
									color: item.statusColor
										? item.statusColor
										: "orange"
								})
							.setLngLat(coords)
							.addTo(map);

						marker.getElement().addEventListener('mouseenter', () => {
							setHoveredItem({
								id: item.id,
								name: item.name,
								address: item.address,
								coords: marker.getLngLat()
							});
						});

						marker.getElement().addEventListener('mouseleave', () => {
							setHoveredItem(null);
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
			mapRef.current.flyTo({ center: coords, zoom: 17 });
		}
	};

	return (
		<div id="root">
			<div className={`sidebar ${!sidebarOpen ? 'closed' : ''}`}>
				<button className="sbr-toggle-btn list-toggle" onClick={() => setSidebarOpen(false)}>
					&laquo; Hide Properties
				</button>
				<div className="cards-container">
					{items.map(item => {
						return (
							<div
								key={item.id}
								onClick={() => {
									setSelectedItemId(item.id);
									flyToItem(item.id);
								}}
								className={`card ${selectedItemId === item.id ? 'selected' : ''}`}>
								{item.thumb
									? (
										<img
											src={item.thumb}
											alt="Thumbnail"
											className="card-thumb"
											onClick={(e) => {
												e.stopPropagation();
												setGalleryImages(item.images);
												setCurrentIndex(0);
											}}
											onError={(e) => {
												e.currentTarget.src = '/placeholder.jpg';
												e.currentTarget.classList.add('image-error');
											}}
										/>
										)
									: (
										<div className="thumb-placeholder" title="Add a file-type column and upload an image to display a gallery here.">
											📷 No image
										</div>
									)
								}
								<div className="card-addr">
									<span>{item.address}</span>
									<a
										href={item.driveLink}
										target="_blank"
										rel="noopener noreferrer"
										className="map-link"
										title="Get Directions">
											Drive there
									</a>
								</div>
								<div>{item.name}</div>
								<ul className="item-cols">
									{item.column_values.map((col, idx) => (
										<li key={idx}>
											<div className="col-label">{col.column.title}</div>
											<div className="col-val" style={{ ...(col.statusColor && { color: col.statusColor }) }}>
												{ autoFormat(col.text) }
											</div>
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
					Show Properties &raquo;
				</button>
			)}
			<div ref={mapContainer} className="map-container">
				{loading && <div style={{ position: 'absolute', zIndex: 1, padding: 10 }}>Loading map data...</div>}
			</div>

			{hoveredItem && mapRef.current && (
				<div
						className={`pin-tooltip ${hoveredItem ? 'show' : ''}`}
						style={{
							position: 'absolute',
							left: `${mapRef.current.project(hoveredItem.coords).x}px`,
							top: `${mapRef.current.project(hoveredItem.coords).y - 40}px`,
							pointerEvents: 'none',
						}}>
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

	function autoFormat(value) {
		if ( /\d{4}-\d{2}-\d{2}/.test(value) ) {
			const date = new Date(value);
			if (isNaN(date)) return value;
			return new Intl.DateTimeFormat('en-US').format(date);
		} else if ( /^\d+$/.test(value) ) {
			const formatter = new Intl.NumberFormat('en-US', {
				minimumFractionDigits: 0,
				maximumFractionDigits: 2
			});
			return formatter.format(value);
		}

		return value;
	}

	function isIOS() {
		return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
	}
}

export default App;
