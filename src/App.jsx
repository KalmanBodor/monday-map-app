import './polyfill.js'; // Import polyfills first
import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import mondaySdk from "monday-sdk-js";
import Modal from 'react-modal';
import { 
	Button, 
	Dropdown, 
	Checkbox,
	Text,
	Label,
	Loader,
	Icon,
	Tooltip,
	Avatar,
	Flex,
	Box
} from '@vibe/core';
import '@vibe/core/tokens'; // Import CSS tokens
import './App.css';
import photoPlaceholder from './assets/city_skyline.svg';

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
	
	// New state for board selection and route planning
	const [boards, setBoards] = useState([]);
	const [selectedBoard, setSelectedBoard] = useState('current');
	const [currentBoardId, setCurrentBoardId] = useState(null);
	const [selectedItems, setSelectedItems] = useState(new Set());
	const [showSelectionModal, setShowSelectionModal] = useState(false);

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

	// Enhanced geocoding function with context data
	async function geocode(address) {
		const resp = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${mapboxgl.accessToken}`);
		const data = await resp.json();
		console.log(data);
		
		if (data.features && data.features[0]) {
			const feature = data.features[0];
			const context = feature.context || [];
			
			// Extract neighborhood and locality
			const neighborhood = context.find(ctx => ctx.id.startsWith('neighborhood.'));
			const locality = context.find(ctx => ctx.id.startsWith('locality.'));
			
			let nhoodCity = '';
			if (neighborhood && locality) {
				nhoodCity = `${neighborhood.text}, ${locality.text}`;
			} else if (locality) {
				nhoodCity = locality.text;
			} else if (neighborhood) {
				nhoodCity = neighborhood.text;
			}
			
			return {
				center: feature.center,
				matching_place_name: feature.place_name,
				nhoodCity: nhoodCity
			};
		}
		
		return null;
	}

	// Fetch all boards
	const fetchBoards = async () => {
		try {
			const query = `
				query {
					boards {
						id
						name
					}
				}
			`;
			const response = await monday.api(query);
			const boardsData = response?.data?.boards || [];
			setBoards(boardsData);
		} catch (err) {
			console.error("Error fetching boards:", err);
		}
	};

	// Fetch items from selected board(s)
	const fetchItemsFromBoard = async (boardSelection, currentBoard = null) => {
		try {
			let boardIds = [];
			
			if (boardSelection === 'current' && currentBoard) {
				boardIds = [currentBoard];
			} else if (boardSelection === 'all') {
				boardIds = boards.map(b => parseInt(b.id)); // Ensure IDs are integers
			} else if (boardSelection !== 'current') {
				boardIds = [parseInt(boardSelection)]; // Ensure ID is integer
			}

			if (boardIds.length === 0) return;

			// Format board IDs properly for GraphQL query
			const boardIdsString = boardIds.join(',');

			const query = `
				query {
					boards(ids: [${boardIdsString}]) {
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
			console.log('API Response:', response);
			
			let allItems = [];
			response?.data?.boards?.forEach(board => {
				const boardItems = board?.items_page?.items || [];
				allItems = [...allItems, ...boardItems];
			});

			allItems = allItems.map(item => {
				const addrCol = item.column_values.find(col => col.column.title.match(/address/i));
				const status = item.column_values.find(col => col.column.title.match(/status/i));
				let statusStyle = null;

				if (status?.value && status.column?.settings_str) {
					try {
						const meta = JSON.parse(status.column.settings_str);
						const val = JSON.parse(status.value);
						statusStyle = { color : meta.labels_colors[val.index]?.color || 'orange', fontWeight: 600 };
						status.statusStyle = statusStyle;
						item.statusStyle = statusStyle;
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
										urlBase = urlBase[0];

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

				return {
					...item,
					address: addrCol?.text || '',
					addressColumnTitle: addrCol?.column?.title || 'Address',
					originalAddress: addrCol?.text || '',
					parsedAddress: '',
					nhoodCity: ''
				};
			});

			setItems(allItems);
			await plotPins(allItems);
		} catch (err) {
			console.error("Error fetching board data:", err);
		}
	};

	// Plot pins with enhanced geocoding
	async function plotPins(itemsToPlot) {
		const map = mapRef.current;
		
		// Clear existing markers
		const existingMarkers = document.querySelectorAll('.mapboxgl-marker');
		existingMarkers.forEach(marker => marker.remove());
		markerCoords.current = {};

		for (const item of itemsToPlot) {
			if (!item.address) continue;

			const geocodeResult = await geocode(item.address);
			if (!geocodeResult) continue;

			const coords = geocodeResult.center;
			markerCoords.current[item.id] = coords;
			
			// Update item with geocoded data
			item.coords = [coords[1], coords[0]].join(',');
			item.parsedAddress = geocodeResult.matching_place_name.replace(/(, )?United States/, '');
			item.nhoodCity = geocodeResult.nhoodCity;
			item.driveLink = isIOS()
				? `http://maps.apple.com/?daddr=${item.coords}`
				: `https://www.google.com/maps/dir/?api=1&destination=${item.coords}`;

			let marker = new mapboxgl.Marker({
				color: item.statusColor ? item.statusColor : "orange"
			})
			.setLngLat(coords)
			.addTo(map);

			marker.getElement().addEventListener('mouseenter', () => {
				setHoveredItem({
					id: item.id,
					name: item.name,
					address: item.parsedAddress,
					coords: marker.getLngLat()
				});
			});

			marker.getElement().addEventListener('mouseleave', () => {
				setHoveredItem(null);
			});
		}
		
		// Update items state with geocoded data
		setItems(prevItems => {
			return prevItems.map(prevItem => {
				const updatedItem = itemsToPlot.find(item => item.id === prevItem.id);
				return updatedItem || prevItem;
			});
		});
	}

	// Handle board selection change
	const handleBoardChange = (option) => {
		const value = option.value;
		setSelectedBoard(value);
		setSelectedItems(new Set()); // Clear selections when changing boards
		setLoading(true);
		fetchItemsFromBoard(value, currentBoardId).finally(() => setLoading(false));
	};

	// Handle item selection
	const handleItemSelection = (itemId, checked) => {
		const newSelection = new Set(selectedItems);
		if (checked) {
			newSelection.add(itemId);
		} else {
			newSelection.delete(itemId);
		}
		setSelectedItems(newSelection);
	};

	// Handle route planning
	const handleRoutePlanning = () => {
		if (selectedItems.size === 0) {
			setShowSelectionModal(true);
			return;
		}

		const selectedItemsArray = Array.from(selectedItems);
		const coordinates = selectedItemsArray
			.map(id => items.find(item => item.id === id))
			.filter(item => item && item.coords)
			.map(item => item.coords);

		if (coordinates.length === 0) return;

		// Create route URL
		const isIOSDevice = isIOS();
		let routeUrl;

		if (coordinates.length === 1) {
			// Single destination
			routeUrl = isIOSDevice
				? `http://maps.apple.com/?daddr=${coordinates[0]}`
				: `https://www.google.com/maps/dir/?api=1&destination=${coordinates[0]}`;
		} else {
			// Multiple destinations
			if (isIOSDevice) {
				// Apple Maps doesn't support multiple waypoints via URL, so use first destination
				routeUrl = `http://maps.apple.com/?daddr=${coordinates[0]}`;
			} else {
				// Google Maps with waypoints
				const destination = coordinates[coordinates.length - 1];
				const waypoints = coordinates.slice(0, -1).join('|');
				routeUrl = `https://www.google.com/maps/dir/?api=1&destination=${destination}&waypoints=${waypoints}`;
			}
		}

		window.open(routeUrl, '_blank');
	};

	// Handle PDF generation
	const handlePDFGeneration = () => {
		if (selectedItems.size === 0) {
			setShowSelectionModal(true);
			return;
		}

		// Create a printable version of selected items
		const selectedItemsData = Array.from(selectedItems)
			.map(id => items.find(item => item.id === id))
			.filter(Boolean);

		// Create a new window with printable content
		const printWindow = window.open('', '_blank');
		const printContent = `
			<!DOCTYPE html>
			<html>
			<head>
				<title>Selected Properties Report</title>
				<style>
					body { font-family: Arial, sans-serif; margin: 20px; }
					.property { margin-bottom: 30px; border-bottom: 1px solid #ccc; padding-bottom: 20px; }
					.property-name { font-size: 18px; font-weight: bold; margin-bottom: 5px; }
					.property-address { color: #666; margin-bottom: 10px; }
					.property-details { list-style: none; padding: 0; }
					.property-details li { margin: 5px 0; }
				</style>
			</head>
			<body>
				<h1>Selected Properties Report</h1>
				<p>Generated on: ${new Date().toLocaleDateString()}</p>
				${selectedItemsData.map(item => `
					<div class="property">
						<div class="property-name">${item.name}</div>
						<div class="property-address">${item.parsedAddress}</div>
						${item.nhoodCity ? `<div class="property-address">${item.nhoodCity}</div>` : ''}
						<ul class="property-details">
							${item.column_values.filter(col => !col.skipDisplayFile).map(col => `
								<li><strong>${col.column.title}:</strong> ${autoFormat(col.text)}</li>
							`).join('')}
						</ul>
					</div>
				`).join('')}
			</body>
			</html>
		`;
		
		printWindow.document.write(printContent);
		printWindow.document.close();
		printWindow.focus();
		printWindow.print();
	};

	useEffect(() => {
		monday.listen("context", async (res) => {
			const boardId = res.data.boardId;
			if (!boardId) return;

			setCurrentBoardId(boardId);
			await fetchBoards();
			setLoading(true);
			await fetchItemsFromBoard('current', boardId);
			setLoading(false);
		});
	}, []);

	const flyToItem = (id) => {
		const coords = markerCoords.current[id];
		if (coords && mapRef.current) {
			mapRef.current.flyTo({ center: coords, zoom: 17 });
		}
	};

	// Prepare dropdown options for board selection
	const boardOptions = [
		{ value: 'current', label: 'Current Board' },
		...boards.filter(board => board.id !== currentBoardId).map(board => ({
			value: board.id,
			label: board.name
		})),
		{ value: 'all', label: 'All Boards' }
	];

	// Find selected option for dropdown
	const selectedOption = boardOptions.find(option => option.value === selectedBoard);

	return (
		<div id="root">
			<Box className={`sidebar ${!sidebarOpen ? 'closed' : ''}`}>
				<Button 
					kind="tertiary" 
					size="small"
					onClick={() => setSidebarOpen(false)}
					className="sbr-toggle-btn list-toggle"
				>
					Hide Properties
				</Button>
				
				<Box padding="medium" style={{ borderBottom: '1px solid var(--border-color)' }}>
					<Label text="Select Board:" />
					<Dropdown
						value={selectedOption}
						options={boardOptions}
						onChange={handleBoardChange}
						placeholder="Select a board"
						className="board-dropdown"
					/>
					
					<Flex gap="small" marginTop="small">
						<Tooltip content="Select at least one property using the checkboxes to plan a route.">
							<Button
								onClick={handleRoutePlanning}
								disabled={selectedItems.size === 0}
								size="small"
								kind={selectedItems.size > 0 ? "primary" : "tertiary"}
							>
								🗺️ Route ({selectedItems.size})
							</Button>
						</Tooltip>
						
						<Tooltip content="Use the checkboxes to choose which properties to include in the PDF.">
							<Button
								onClick={handlePDFGeneration}
								disabled={selectedItems.size === 0}
								size="small"
								kind={selectedItems.size > 0 ? "primary" : "tertiary"}
							>
								📄 PDF ({selectedItems.size})
							</Button>
						</Tooltip>
					</Flex>
				</Box>

				<Box className="cards-container" padding="small">
					{items.map(item => {
						return (
							<Box 
								key={item.id}
								className={`property-card ${selectedItemId === item.id ? 'selected' : ''}`}
								onClick={() => {
									setSelectedItemId(item.id);
									flyToItem(item.id);
								}}
							>
								<Box>
									<Box className="thumb-wrapper">
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
											<Tooltip content="Add a 'Files' column and upload images to display a photo gallery here.">
												<Box className="card-thumb no-photo">
													<Avatar
														src={photoPlaceholder}
														alt="No photo"
														size="large"
														type="img"
													/>
												</Box>
											</Tooltip>
										)}
									</Box>
									
									<Box className="card-content">
										<Text 
											element="div" 
											className="card-addr"
											color="secondary"
										>
											{item.parsedAddress || item.address}
										</Text>
										
										<Flex align="center" gap="small" marginTop="xs">
											<Tooltip content="Select for route planning or printing to PDF">
												<Checkbox
													checked={selectedItems.has(item.id)}
													onChange={(checked) => handleItemSelection(item.id, checked)}
													onClick={(e) => e.stopPropagation()}
												/>
											</Tooltip>
										</Flex>
										
										<Text element="div" weight="bold" className="property-name">
											{item.name}
										</Text>
										
										<Box className="item-details" marginTop="small">
											{item.nhoodCity && (
												<Flex justify="space-between" marginBottom="xs">
													<Text size="small" color="secondary">Nhood/City</Text>
													<Text size="small">{item.nhoodCity}</Text>
												</Flex>
											)}
											
											{item.originalAddress && (
												<Flex justify="space-between" marginBottom="xs">
													<Text size="small" color="secondary">{item.addressColumnTitle}</Text>
													<Text size="small">{item.originalAddress}</Text>
												</Flex>
											)}
											
											{item.column_values.map((col, idx) => (
												!col.skipDisplayFile && !col.column.title.match(/address/i) && (
													<Flex key={idx} justify="space-between" marginBottom="xs">
														<Text size="small" color="secondary">{col.column.title}</Text>
														<Text 
															size="small" 
															style={col.statusStyle}
														>
															{autoFormat(col.text)}
														</Text>
													</Flex>
												)
											))}
										</Box>
									</Box>
								</Box>
							</Box>
						);
					})}
				</Box>
			</Box>

			{!sidebarOpen && (
				<Button 
					kind="primary" 
					size="small"
					onClick={() => setSidebarOpen(true)}
					className="sidebar-toggle"
				>
					Show Properties
				</Button>
			)}
			
			<Box ref={mapContainer} className="map-container">
				{loading && (
					<Box className="loading-overlay">
						<Loader />
						<Text>Loading map data...</Text>
					</Box>
				)}
			</Box>

			{hoveredItem && mapRef.current && (
				<Box
					className={`pin-tooltip ${hoveredItem ? 'show' : ''}`}
					style={{
						position: 'absolute',
						left: `${mapRef.current.project(hoveredItem.coords).x}px`,
						top: `${mapRef.current.project(hoveredItem.coords).y - 40}px`,
						pointerEvents: 'none',
					}}>
					<Box className="pin-tooltip-content">
						<Text size="small" color="secondary">{hoveredItem.address}</Text>
						<Text size="small" weight="bold">{hoveredItem.name}</Text>
					</Box>
				</Box>
			)}

			<Modal
				isOpen={galleryImages.length > 0}
				onRequestClose={() => setGalleryImages([])}
				className="modal"
				overlayClassName="overlay"
				contentLabel="Image Gallery"
			>
				{galleryImages.length > 0 && (
					<Box className="modal-content">
						<Button 
							onClick={() => setGalleryImages([])}
							className="close-btn"
							kind="tertiary"
							size="small"
						>
							×
						</Button>
						<Button 
							onClick={() => setCurrentIndex(i => (i - 1 + galleryImages.length) % galleryImages.length)}
							className="nav-btn left"
							kind="tertiary"
							size="small"
						>
							‹
						</Button>
						<img src={galleryImages[currentIndex]} alt="Gallery" className="gallery-image-large" />
						<Button 
							onClick={() => setCurrentIndex(i => (i + 1) % galleryImages.length)}
							className="nav-btn right"
							kind="tertiary"
							size="small"
						>
							›
						</Button>
					</Box>
				)}
			</Modal>

			{/* Selection Modal */}
			<Modal
				isOpen={showSelectionModal}
				onRequestClose={() => setShowSelectionModal(false)}
				className="modal"
				overlayClassName="overlay"
				contentLabel="Selection Required"
			>
				<Box className="selection-modal">
					<Text element="h3">Selection Required</Text>
					<Text>Please select at least one property using the checkboxes before proceeding.</Text>
					<Flex justify="flex-end" marginTop="medium">
						<Button onClick={() => setShowSelectionModal(false)}>
							OK
						</Button>
					</Flex>
				</Box>
			</Modal>
		</div>
	);

	function autoFormat(value) {
		if (/\d{4}-\d{2}-\d{2}/.test(value)) {
			const date = new Date(value);
			if (isNaN(date)) return value;
			return new Intl.DateTimeFormat('en-US').format(date);
		} else if (/^\d+$/.test(value)) {
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