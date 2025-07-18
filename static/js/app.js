// static/js/app.js
(function () {
    'use strict';

    // --- Constants ---
    const OFFLINE_THRESHOLD = 30 * 1000; // 30 seconds in milliseconds
    const STATUS_CHECK_INTERVAL = 5 * 1000; // Check status every 5 seconds
    const MAP_UPDATE_DEBOUNCE = 150; // Debounce map marker updates (ms)
    const FEEDBACK_CLEAR_DELAY = 10000; // Auto-clear command feedback after 10s
    const DEFAULT_MAP_CENTER = [21.0285, 105.8542]; // Hanoi (Example)
    const DEFAULT_MAP_ZOOM = 13;
    const CONTROLLER_MAP_ZOOM = 17; // Zoom level for controller map
    const ARRIVED_CONFIRMATION_CODE = 3; // Match ServerCommand.msg confirmation code for ARRIVED

    // --- Socket.IO Connection ---
    const socket = io({
        reconnectionAttempts: 5,
        timeout: 10000,
    });

    // --- State Variables ---
    let knownRobots = [];
    let expectedSubTopics = [];
    let latestData = {}; // { robotId: { last_seen: ms, topics: { subTopic: { payload: ..., timestamp: ms } } } }
    let robotStatus = {}; // { robotId: 'online' | 'offline' | 'waiting' }
    let currentView = 'dashboard-view';
    let selectedRobot = null;
    let selectedSubTopic = null;
    // Dashboard Map
    let osmMap = null;
    let robotMarker = null;
    let robotIcon = null;
    let dashboardPathPolyline = null;
    let mapUpdateTimer = null;
    // Controller Map & State
    let controllerMapInstance = null;
    let customerMarker = null;
    let controllerRobotMarker = null;
    let customerLatLng = null; // Stores L.LatLng of the final customer
    let currentSelectionMode = null; // 'addStore', 'customer', or null
    let controllerPathPolyline = null;
    // Sequence State
    let storePointsSequence = []; // Array of { latlng: L.LatLng, marker: L.Marker, status: 'pending'|'target'|'done', dragHandler: function }
    let sequenceActive = false;
    let currentSequenceIndex = -1;
    // Timers & Intervals
    let statusCheckInterval = null;
    let feedbackClearTimers = {}; // { feedbackId: timerId }

    // --- DOM Elements Cache ---
    const dom = {
        sidebarNavItems: document.querySelectorAll('.sidebar-nav .nav-item'),
        contentViews: document.querySelectorAll('.content-area .content-view'),
        robotSelector: document.getElementById('robot-selector'),
        topicListContainer: document.getElementById('topic-list'),
        topicListHeader: document.getElementById('topic-list-header'),
        dataDisplayHeader: document.getElementById('topic-data-header'),
        dataDisplayElement: document.getElementById('mqtt-data-display'),
        mapCanvasContainer: document.getElementById('routed-map-canvas-container'),
        mapCanvas: document.getElementById('routed-map-canvas'),
        mapCtx: document.getElementById('routed-map-canvas')?.getContext('2d'),
        canvasStatus: document.querySelector('#routed-map-canvas-container .canvas-status'),
        dataContentArea: document.getElementById('data-content-area'),
        osmMapContainer: document.getElementById('osm-map-container'),
        osmMapElement: document.getElementById('osm-map'),
        connectionStatusSidebar: document.getElementById('connection-status-sidebar'),
        connectionStatusHeader: document.getElementById('connection-status-header'),
        controllerView: document.getElementById('controller-view'),
        controllerContent: document.getElementById('controller-content'),
        controllerStatusMsg: document.getElementById('controller-status'),
        cmdFeedbackArea: document.getElementById('command-feedback-area'),
        sendJoystickCmdBtn: document.getElementById('send-joystick-cmd'),
        testServerCmdBtn: document.getElementById('test-server-cmd'),
        // Quick Commands
        quickNavBtn: document.getElementById('quick-nav-btn'),
        quickLatInput: document.getElementById('quick-lat'),
        quickLonInput: document.getElementById('quick-lon'),
        emergencyStopBtn: document.getElementById('emergency-stop-btn'),
        cancelMissionBtn: document.getElementById('cancel-mission-btn'),
        toggleBtns: document.querySelectorAll('#controller-view .toggle-btn'),
        allControllerSendBtns: document.querySelectorAll('#controller-view .send-button, #controller-view .seq-btn'), // Includes joystick, test, and sequence buttons
        controllerMapElement: document.getElementById('controller-map'),
        addStorePointBtn: document.getElementById('add-store-point-btn'),
        selectCustomerBtn: document.getElementById('select-customer-btn'),
        mapSelectionStatus: document.getElementById('map-selection-status'),
        sequencePointsListElement: document.getElementById('sequence-points-list'),
        selectedPointsDisplay: document.getElementById('selected-points-display'),
        targetCoordsSpan: document.getElementById('target-coords'),
        customerCoordsSpan: document.getElementById('customer-coords'),
        srvCustLatInput: document.getElementById('srv-cust-lat'),
        srvCustLonInput: document.getElementById('srv-cust-lon'),
        srvCustZInput: document.getElementById('srv-cust-z'),
        startSequenceBtn: document.getElementById('start-sequence-btn'),
        stopSequenceBtn: document.getElementById('stop-sequence-btn'),
        clearSequenceBtn: document.getElementById('clear-sequence-btn'),
        sequenceStatusElement: document.getElementById('sequence-status'),
        srvOpModeSelect: document.getElementById('srv-op-mode'),
        srvDriveTeleBtn: document.getElementById('srv-drive-tele'),
        srvOpenLidBtn: document.getElementById('srv-open-lid'),
        srvEmbMapInput: document.getElementById('srv-emb-map'),
    };

    // --- Logging Helper ---
    const log = {
        // --- MODIFIED: Use console.debug for detailed logs ---
        info: (...args) => console.info('[INFO]', ...args), // Keep info for general flow
        warn: (...args) => console.warn('[WARN]', ...args),
        error: (...args) => console.error('[ERROR]', ...args),
        debug: (...args) => console.debug('[DEBUG]', ...args) // Use debug for detailed tracing
    };

    // --- Initialization ---
    function initializeDashboard() {
        log.info('Initializing Dashboard...');
        setupEventListeners();
        defineRobotIcon(); // Define icon early
        initOsmMap(); // Init dashboard map
        showView(currentView); // Show default view
        updateConnectionStatus(false, 'Connecting...');
        setStatus("Connecting to server...", true);
        dom.robotSelector.disabled = true;
        disableController("Connecting...");
        log.info('Dashboard Initialized.');
    }

    function defineRobotIcon() {
        try {
            robotIcon = L.icon({
                iconUrl: '/static/assets/robot.png', // Verify this path
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            });
            log.debug("Robot icon defined."); // Added debug log
        } catch (e) {
            log.error("Failed to create Leaflet icon:", e);
            // Implement fallback if needed
        }
    }

    function initOsmMap() {
        // Initialize dashboard map
        if (osmMap || !dom.osmMapElement) return;
        try {
            osmMap = L.map(dom.osmMapElement, { zoomControl: true }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap contributors'
            }).addTo(osmMap);
            log.info("Dashboard OSM Map Initialized");
        } catch (e) {
            log.error("Dashboard OSM Map initialization failed:", e);
            if (dom.osmMapElement) dom.osmMapElement.innerHTML = '<p class="waiting error">Map failed to load.</p>';
        }
    }

    function initControllerMap() {
        // Initialize controller map (only if needed and not already initialized)
        if (controllerMapInstance || !dom.controllerMapElement) {
            if (controllerMapInstance) setTimeout(() => controllerMapInstance.invalidateSize(), 50); // Ensure redraw if already exists
            return;
        }
        try {
            log.info("Initializing Controller Map...");
            controllerMapInstance = L.map(dom.controllerMapElement, { zoomControl: true }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap contributors'
            }).addTo(controllerMapInstance);

            controllerMapInstance.on('click', handleControllerMapClick);
            if (!robotIcon) defineRobotIcon();

            // Initialize markers (hidden initially)
            customerMarker = L.marker(DEFAULT_MAP_CENTER, { draggable: true, opacity: 0, zIndexOffset: 900 })
                .addTo(controllerMapInstance)
                .bindPopup("Final Customer Location (Drag to adjust)");
            controllerRobotMarker = L.marker(DEFAULT_MAP_CENTER, { icon: robotIcon, opacity: 0, zIndexOffset: 500 })
                .addTo(controllerMapInstance)
                .bindPopup("Selected Robot Position");

            customerMarker.on('dragend', (e) => handleMarkerDragEnd(e, 'customer'));

            log.info("Controller Map Initialized.");

            // Update map state based on current selections
            if (selectedRobot) {
                centerControllerMapOnRobot();
                updateControllerMapRobotMarker();
                updateControllerMapRoute();
            }
            updateStoredMarkerPositions(); // Restore sequence/customer markers
            renderSequenceList(); // Render sequence list if points exist

        } catch (e) {
            log.error("Controller Map initialization failed:", e);
            if (dom.controllerMapElement) dom.controllerMapElement.innerHTML = '<p class="waiting error">Map failed to load.</p>';
        }
    }

    // --- Status & UI Updates ---
    function setStatus(message, isWaiting = true) {
        // Update the main data display area's header and content
        if (!dom.dataDisplayHeader) return;
        dom.dataDisplayHeader.textContent = message;

        // Reset layout to default (text display, centered waiting message)
        dom.osmMapContainer.style.display = 'none';
        dom.mapCanvasContainer.style.display = 'none';
        if (dom.canvasStatus) dom.canvasStatus.style.display = 'none';
        dom.dataDisplayElement.style.display = 'flex'; // Use flex for centering
        dom.dataDisplayElement.textContent = message;
        dom.dataDisplayElement.className = 'mqtt-data-display scrollable waiting'; // Set waiting class
        dom.dataContentArea.style.justifyContent = 'center';
        dom.dataContentArea.style.alignItems = 'center';

        // Update topic list header/content if status indicates no selection or error
        if (!selectedRobot || message.toLowerCase().includes('error') || message.toLowerCase().includes('no robot')) {
            if (dom.topicListContainer) dom.topicListContainer.innerHTML = `<p class="waiting" style="padding: 15px;">${message}</p>`;
            if (dom.topicListHeader) dom.topicListHeader.textContent = "Topics"; // Reset header
        }
    }

    function updateConnectionStatus(isConnected, message = '') {
        // Update connection status indicators in sidebar and header
        const elements = [dom.connectionStatusSidebar, dom.connectionStatusHeader];
        elements.forEach(el => {
            if (!el) return;
            const dot = el.querySelector('.status-dot');
            const text = el.querySelector('.status-text');
            if (!dot || !text) return;

            dot.className = 'status-dot'; // Reset classes
            if (isConnected) {
                dot.classList.add('connected');
                text.textContent = message || 'Connected';
            } else {
                const isError = message.toLowerCase().includes('error') || message.toLowerCase().includes('disconnect');
                dot.classList.add(isError ? 'disconnected' : 'connecting');
                text.textContent = message || (isError ? 'Disconnected' : 'Connecting...');
            }
        });
    }

    function disableController(message, isOfflineOrError = false) {
        // Disable the entire controller content area
        if (!dom.controllerContent) return;
        dom.controllerContent.classList.add('controller-disabled'); // CSS handles pointer-events:none
        if (dom.controllerStatusMsg) {
            dom.controllerStatusMsg.textContent = message || "Controller disabled.";
            const statusType = isOfflineOrError ? (message.toLowerCase().includes('offline') ? 'warning' : 'error') : 'info';
            dom.controllerStatusMsg.className = `status-message ${statusType}`;
            dom.controllerStatusMsg.style.display = 'block';
        }
        // Explicitly disable buttons for clarity (though CSS overlay might suffice)
        dom.allControllerSendBtns.forEach(btn => btn.disabled = true);
        if(dom.addStorePointBtn) dom.addStorePointBtn.disabled = true;
        if(dom.selectCustomerBtn) dom.selectCustomerBtn.disabled = true;
    }

    function enableController() {
        // Enable the controller content area
        if (!dom.controllerContent) return;
        dom.controllerContent.classList.remove('controller-disabled');
        if (dom.controllerStatusMsg) dom.controllerStatusMsg.style.display = 'none'; // Hide status message
        
        // Enable main command buttons
        if(dom.sendJoystickCmdBtn) dom.sendJoystickCmdBtn.disabled = false;
        if(dom.testServerCmdBtn) dom.testServerCmdBtn.disabled = false;
        
        // Enable Quick Commands buttons
        if(dom.quickNavBtn) dom.quickNavBtn.disabled = false;
        if(dom.emergencyStopBtn) dom.emergencyStopBtn.disabled = false;
        if(dom.cancelMissionBtn) dom.cancelMissionBtn.disabled = false;
        
        updateSequenceControlButtonStates(); // Correctly sets sequence/map button states
    }

    // --- Robot Status Checking ---
    function checkAllRobotStatuses() {
        const now = Date.now();
        let changed = false;
        let selectedRobotIsNowOnline = false;

        for (const robotId of knownRobots) {
            const lastSeen = latestData[robotId]?.last_seen || 0;
            let newStatus = 'offline';
            if (lastSeen === 0) newStatus = 'waiting';
            else if ((now - lastSeen) < OFFLINE_THRESHOLD) newStatus = 'online';

            if (robotStatus[robotId] !== newStatus) {
                log.debug(`Robot ${robotId} status changed: ${robotStatus[robotId] || 'none'} -> ${newStatus}`);
                robotStatus[robotId] = newStatus;
                changed = true;
            }
            if (robotId === selectedRobot && newStatus === 'online') {
                selectedRobotIsNowOnline = true;
            }
        }

        if (changed) {
            updateRobotStatusUI(); // Update dropdown and topic header visuals
        }

        // Update controller enabled/disabled state based on selected robot
        if (currentView === 'controller-view') { // Only manage controller state if it's the active view
            if (selectedRobot) {
                const currentStatus = robotStatus[selectedRobot];
                if (currentStatus === 'online') {
                    if (dom.controllerContent?.classList.contains('controller-disabled')) {
                        log.info(`Selected robot ${selectedRobot} is online, enabling controller.`);
                        enableController();
                    }
                } else {
                    const message = currentStatus === 'offline' ? `Robot '${selectedRobot}' is offline. Controls disabled.` : `Waiting for '${selectedRobot}'. Controls disabled.`;
                    disableController(message, true);
                    if (sequenceActive) {
                        log.warn(`Robot ${selectedRobot} went offline during active sequence. Stopping sequence.`);
                        stopSequence('error'); // Auto-stop sequence if robot goes offline
                    }
                }
            } else {
                disableController("Please select a robot."); // No robot selected
            }
        }

        // Always update sequence button states, as they depend on multiple factors
        updateSequenceControlButtonStates();
    }

    function updateRobotStatusUI() {
        // Update robot status text in the dropdown selector
        if (!dom.robotSelector) return;
        const options = dom.robotSelector.options;
        for (let i = 0; i < options.length; i++) {
            const option = options[i];
            const robotId = option.value;
            if (robotId && robotStatus[robotId]) {
                const status = robotStatus[robotId];
                let statusText = '';
                if (status === 'online') statusText = ' (Online)';
                else if (status === 'offline') statusText = ' (Offline)';
                else if (status === 'waiting') statusText = ' (Waiting)';
                option.textContent = robotId + statusText;
                option.className = status; // For potential CSS styling based on status
            }
        }

        // Update topic list header with status dot
        if (dom.topicListHeader) {
            if (selectedRobot && robotStatus[selectedRobot]) {
                const status = robotStatus[selectedRobot];
                const statusClass = status === 'online' ? 'connected' : (status === 'offline' ? 'disconnected' : 'connecting');
                dom.topicListHeader.innerHTML = `<span class="status-dot-inline ${statusClass}"></span> Topics for ${selectedRobot}`;
            } else if (selectedRobot) {
                dom.topicListHeader.textContent = `Topics for ${selectedRobot}`; // Fallback if status missing
            } else {
                dom.topicListHeader.textContent = "Topics"; // Default header
            }
        }
    }

    // --- Robot Handling ---
    function populateRobotSelector() {
        // Fill the robot dropdown list based on knownRobots
        if (!dom.robotSelector) return;
        const currentSelectedValue = selectedRobot;
        dom.robotSelector.innerHTML = ''; // Clear existing

        if (knownRobots.length === 0) {
            const option = document.createElement('option');
            option.value = ""; option.textContent = "-- No Robots Defined --";
            dom.robotSelector.appendChild(option);
            dom.robotSelector.disabled = true;
            setStatus("No robots defined by the server.");
            disableController("No robots defined.");
            return;
        }

        dom.robotSelector.disabled = false;
        const promptOption = document.createElement('option');
        promptOption.value = ""; promptOption.textContent = "-- Select a Robot --";
        promptOption.disabled = selectedRobot !== null; // Disable prompt if a robot is active
        dom.robotSelector.appendChild(promptOption);

        knownRobots.forEach(robotId => {
            const option = document.createElement('option');
            option.value = robotId; option.textContent = robotId; // Status text added later
            dom.robotSelector.appendChild(option);
        });

        // Restore selection or reset
        if (currentSelectedValue && knownRobots.includes(currentSelectedValue)) {
            dom.robotSelector.value = currentSelectedValue;
        } else {
            dom.robotSelector.value = "";
            if (selectedRobot !== null) selectRobot(null); // Deselect if previous choice is invalid
        }
        checkAllRobotStatuses(); // Update status text immediately
    }

    function selectRobot(robotId) {
        // Handle robot selection change
        if (robotId === selectedRobot) return; // No change

        if (!robotId) { // Deselecting
            if (selectedRobot === null) return; // Already deselected
            log.info("Robot deselected.");
            selectedRobot = null;
            selectedSubTopic = null;
            setStatus("Please select a robot.", true);
            populateTopicList(null);
            if (dom.robotSelector) {
                dom.robotSelector.value = "";
                const promptOption = dom.robotSelector.querySelector('option[value=""]');
                if (promptOption) promptOption.disabled = false;
            }
            // Clear map elements
            if (robotMarker) { robotMarker.remove(); robotMarker = null; }
            if (dashboardPathPolyline) { dashboardPathPolyline.remove(); dashboardPathPolyline = null; }
            if (controllerRobotMarker) controllerRobotMarker.setOpacity(0);
            if (controllerPathPolyline) { controllerPathPolyline.remove(); controllerPathPolyline = null; }
            clearSequence(); // Clear sequence data and UI
            renderData(); // Clear data display
            disableController("Please select a robot.");
            if (dom.topicListHeader) dom.topicListHeader.textContent = "Topics";
            return;
        }

        // Selecting a new robot
        log.info(`Robot selected: ${robotId}`);
        selectedRobot = robotId;
        selectedSubTopic = null; // Reset topic on robot change

        // Clear previous robot's map elements if needed
        if (robotMarker) { robotMarker.remove(); robotMarker = null; }
        if (dashboardPathPolyline) { dashboardPathPolyline.remove(); dashboardPathPolyline = null; }

        populateTopicList(robotId);
        setStatus(`Select a topic for ${selectedRobot}.`, true);
        if (dom.robotSelector) {
            const promptOption = dom.robotSelector.querySelector('option[value=""]');
            if (promptOption) promptOption.disabled = true; // Disable prompt
        }

        clearSequence(); // Clear sequence from previous robot
        renderData(); // Clear data display area
        checkAllRobotStatuses(); // Update status UI and controller state

        // Update maps for the newly selected robot
        updateOsmMapPositionFromStatus();
        if(osmMap) updateGpsPathFromState(osmMap, 'dashboard');
        initControllerMap(); // Ensure controller map is ready
        centerControllerMapOnRobot();
        updateControllerMapRobotMarker();
        updateControllerMapRoute();
        updateStoredMarkerPositions(); // Make sure customer/store markers are positioned

        if (currentView === 'controller-view' && controllerMapInstance) {
            setTimeout(() => controllerMapInstance.invalidateSize(), 50); // Redraw map
        }
    }

    // --- Topic Handling ---
    function getSubTopicsForRobot(robotId) {
        // Get list of topics (expected + received) for the selected robot
        if (!robotId || !latestData[robotId]?.topics) return [];
        const combinedTopics = new Set(expectedSubTopics || []);
        Object.keys(latestData[robotId].topics).forEach(key => combinedTopics.add(key));
        return Array.from(combinedTopics).sort();
    }

    function populateTopicList(robotId) {
        // Update the list of topics in the sidebar
        if (!dom.topicListContainer || !dom.topicListHeader) return;
        dom.topicListContainer.innerHTML = ''; // Clear

        if (!robotId) {
            dom.topicListContainer.innerHTML = `<p class="waiting" style="padding: 15px;">Select a robot first.</p>`;
            dom.topicListHeader.textContent = "Topics";
            return;
        }

        updateRobotStatusUI(); // Ensure header has correct status dot

        const subTopics = getSubTopicsForRobot(robotId);
        if (subTopics.length === 0) {
            dom.topicListContainer.innerHTML = `<p class="waiting" style="padding: 15px;">No topics received yet for ${robotId}.</p>`;
            return;
        }

        subTopics.forEach(subTopic => {
            const topicItem = document.createElement('div');
            topicItem.className = 'topic-item';
            topicItem.textContent = subTopic;
            topicItem.dataset.subTopic = subTopic;
            topicItem.onclick = () => selectSubTopic(subTopic);
            if (selectedRobot === robotId && selectedSubTopic === subTopic) {
                topicItem.classList.add('active');
            }
            dom.topicListContainer.appendChild(topicItem);
        });
    }

    function selectSubTopic(subTopic) {
        // Handle selecting a topic from the sidebar list
        if (!subTopic || !selectedRobot) return;
        log.info(`Topic selected: ${selectedRobot}/${subTopic}`); // Changed to info
        selectedSubTopic = subTopic;

        // Update active class in list
        dom.topicListContainer?.querySelectorAll('.topic-item').forEach(item => {
            item.classList.toggle('active', item.dataset.subTopic === selectedSubTopic);
        });

        configureLayoutForTopic(subTopic); // Adjust UI layout
        renderData(); // Display data for the selected topic
    }

    // --- Layout Configuration ---
    function configureLayoutForTopic(topic) {
        log.debug(`Configuring layout for topic: ${topic}`); // Added debug log
        // Adjust the main content area layout based on the selected topic
        // Ensure maps are initialized if needed
        if (topic === 'routed_map' || topic === 'gloal_path_gps' || topic === 'robot_status') initOsmMap();
        if (currentView === 'controller-view' || topic === 'gloal_path_gps' || topic === 'robot_status') initControllerMap();

        // Reset layout elements
        dom.dataDisplayElement.style.display = 'block';
        dom.osmMapContainer.style.display = 'none';
        dom.mapCanvasContainer.style.display = 'none';
        if (dom.canvasStatus) dom.canvasStatus.style.display = 'none';
        dom.dataContentArea.style.flexDirection = 'row'; // Default row
        dom.dataDisplayElement.style.width = '100%';
        dom.osmMapContainer.style.width = '0%';
        dom.mapCanvasContainer.style.width = '0%';
        dom.dataContentArea.style.justifyContent = 'flex-start'; // Default
        dom.dataContentArea.style.alignItems = 'stretch'; // Default

        // Apply specific layouts
        if (topic === 'routed_map') {
            log.debug("Setting layout for routed_map: Map + Canvas");
            dom.dataDisplayElement.style.display = 'none';
            dom.osmMapContainer.style.display = 'block';
            dom.mapCanvasContainer.style.display = 'flex'; // Make container visible and use flex for centering status
            dom.osmMapContainer.style.width = '60%';
            dom.mapCanvasContainer.style.width = '40%';
            if (osmMap) setTimeout(() => { log.debug("Invalidating OSM map size"); osmMap.invalidateSize(); }, 50);
            updateOsmMapPositionFromStatus();
        } else if (topic === 'gloal_path_gps') {
            log.debug("Setting layout for gloal_path_gps: Full Map");
            dom.dataDisplayElement.style.display = 'none';
            dom.osmMapContainer.style.display = 'block';
            dom.osmMapContainer.style.width = '100%';
            if (osmMap) setTimeout(() => { log.debug("Invalidating OSM map size"); osmMap.invalidateSize(); }, 50);
            updateOsmMapPositionFromStatus();
            updateGpsPathFromState(osmMap, 'dashboard'); // Draw path immediately
        } else if (topic === 'robot_status') {
            log.debug("Setting layout for robot_status: Text + Update Map Markers");
            // Keep default text layout, but update map markers
            if (osmMap) updateOsmMapPositionFromStatus();
            if (controllerMapInstance) updateControllerMapRobotMarker();
        } else {
             log.debug(`Setting default text layout for topic: ${topic}`);
             // Ensure text area is visible and takes full width
             dom.dataDisplayElement.style.display = 'block';
             dom.dataDisplayElement.style.width = '100%';
             dom.osmMapContainer.style.display = 'none';
             dom.mapCanvasContainer.style.display = 'none';
        }
        // Else: Default layout (full-width text display) is already set
    }

    // --- Data Rendering ---
    function renderData() {
        log.debug(`renderData called. Robot: ${selectedRobot}, Topic: ${selectedSubTopic}`);
        // Display data for the currently selected robot and topic
        if (!selectedRobot || !selectedSubTopic) {
            const msg = !selectedRobot ? "Select a robot to view data." : `Select a topic for ${selectedRobot}.`;
            log.debug(`renderData: No robot/topic selected. Setting status: "${msg}"`);
            setStatus(msg, true);
            return;
        }

        const topicEntry = latestData[selectedRobot]?.topics?.[selectedSubTopic];
        const data = topicEntry?.payload; // The actual message payload
        const timestamp = topicEntry?.timestamp; // Timestamp from backend wrapper
        let isWaitingOrError = false;
        let statusMessage = "";
        let headerText = `Data: ${selectedRobot}/${selectedSubTopic}`;
        const currentRobotStatus = robotStatus[selectedRobot] || 'waiting';
        log.debug(`renderData: Found topic entry. Payload type: ${typeof data}, Timestamp: ${timestamp}`);

        // Determine data status
        if (data === undefined || data === "waiting...") {
            isWaitingOrError = true;
            statusMessage = currentRobotStatus === 'offline' ? `Robot '${selectedRobot}' is offline. Data may be stale.` : `Waiting for message on ${selectedRobot}/${selectedSubTopic}...`;
            headerText += ` (${currentRobotStatus === 'offline' ? 'Offline?' : 'Waiting'})`;
            log.debug(`renderData: Data is waiting/undefined. Status: "${statusMessage}"`);
        } else if (typeof data === 'string' && data.startsWith("Error:")) {
            isWaitingOrError = true;
            statusMessage = data; // Show error from backend
            headerText += ' (Data Error)';
            log.warn(`renderData: Data contains error string: "${statusMessage}"`);
        }

        if (timestamp && timestamp > 0) headerText += ` (${formatTimeAgo(timestamp)})`;
        if (dom.dataDisplayHeader) dom.dataDisplayHeader.textContent = headerText;

        // Render based on topic type
        if (selectedSubTopic === 'routed_map') {
            log.debug("renderData: Handling 'routed_map'");
            // Ensure layout is correct FIRST
            configureLayoutForTopic('routed_map'); // Re-call to ensure layout is set
            if (isWaitingOrError) {
                log.debug("renderData (routed_map): Waiting or Error state.");
                if (dom.mapCtx) {
                    log.debug("renderData (routed_map): Clearing canvas.");
                    dom.mapCtx.clearRect(0, 0, dom.mapCanvas.width, dom.mapCanvas.height);
                 }
                if (dom.canvasStatus) {
                    log.debug(`renderData (routed_map): Setting canvas status: "${statusMessage}"`);
                    dom.canvasStatus.textContent = statusMessage || 'Waiting for map data...';
                    dom.canvasStatus.className = 'canvas-status waiting';
                    dom.canvasStatus.style.display = 'block'; // Ensure visible
                }
            } else {
                // Call drawMap only if layout is configured and data is valid
                 log.debug('>>> renderData (routed_map): Calling drawMap with payload:', data); // ADDED Log before calling
                drawMap(dom.mapCanvas, dom.mapCtx, data); // data is the image message object {width, height, encoding, data:[...]}
                if (dom.canvasStatus) dom.canvasStatus.style.display = 'none';
            }
            if (osmMap) updateOsmMapPositionFromStatus(); // Update context map marker
        } else if (selectedSubTopic === 'gloal_path_gps') {
             log.debug("renderData: Handling 'gloal_path_gps'");
            // Layout handled by configureLayoutForTopic, just need to draw path
            configureLayoutForTopic('gloal_path_gps'); // Ensure map is visible
            if (isWaitingOrError) {
                 log.debug("renderData (gloal_path_gps): Waiting or Error state. Clearing polyline.");
                if (dashboardPathPolyline) { dashboardPathPolyline.remove(); dashboardPathPolyline = null; }
            } else {
                log.debug("renderData (gloal_path_gps): Drawing path with payload:", data);
                drawGpsPath(data, osmMap, 'dashboard'); // data is the path payload
            }
            if (osmMap) updateOsmMapPositionFromStatus(); // Update marker too
        } else { // Default text display
             log.debug(`renderData: Handling default text display for topic: ${selectedSubTopic}`);
             configureLayoutForTopic(selectedSubTopic); // Ensure default layout is set
            if (isWaitingOrError) {
                log.debug(`renderData (text): Waiting or Error state. Message: "${statusMessage}"`);
                dom.dataDisplayElement.textContent = statusMessage;
                dom.dataDisplayElement.className = 'mqtt-data-display scrollable waiting';
                dom.dataDisplayElement.style.display = 'flex'; // Center waiting message
                 dom.dataContentArea.style.justifyContent = 'center';
                 dom.dataContentArea.style.alignItems = 'center';
            } else {
                dom.dataDisplayElement.className = 'mqtt-data-display scrollable';
                dom.dataDisplayElement.style.display = 'block'; // Normal block display
                 dom.dataContentArea.style.justifyContent = 'flex-start';
                 dom.dataContentArea.style.alignItems = 'stretch';
                try {
                    const displayText = (typeof data === 'object' && data !== null) ? JSON.stringify(data, null, 2) : String(data);
                    dom.dataDisplayElement.textContent = displayText;
                     log.debug(`renderData (text): Displaying data (first 100 chars): ${displayText.substring(0, 100)}...`);
                } catch (e) {
                    log.error("Error stringifying data for display:", e);
                    dom.dataDisplayElement.textContent = `Display Error: ${e.message}`;
                    dom.dataDisplayElement.className = 'mqtt-data-display scrollable waiting';
                    dom.dataDisplayElement.style.display = 'flex';
                    dom.dataContentArea.style.justifyContent = 'center';
                    dom.dataContentArea.style.alignItems = 'center';
                }
            }
            // Update map markers if displaying robot_status
            if (selectedSubTopic === 'robot_status') {
                log.debug("renderData: Updating map markers for robot_status.");
                if (osmMap) updateOsmMapPositionFromStatus();
                if (controllerMapInstance) updateControllerMapRobotMarker();
            }
        }
    }


    function formatTimeAgo(timestamp) {
        // Format timestamp into readable relative time
        if (!timestamp || timestamp <= 0) return "never";
        const now = Date.now();
        const secondsPast = Math.round((now - timestamp) / 1000);
        if (secondsPast < 2) return "just now";
        if (secondsPast < 60) return `${secondsPast}s ago`;
        if (secondsPast < 3600) return `${Math.round(secondsPast / 60)}m ago`;
        if (secondsPast <= 86400) return `${Math.round(secondsPast / 3600)}h ago`;
        const date = new Date(timestamp);
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); // Simple date + time
    }

    // --- Canvas Drawing ---
    // function drawMap(canvas, ctx, imageMsg) {
    //     // --- ADDED: Log entry and received data ---
    //     log.debug(">>> drawMap function called. Received imageMsg:", imageMsg);

    //     // Draw image data onto the canvas (robust version + ROTATION + SCALING to CONTAINER)
    //     if (!canvas || !ctx) { log.error("Canvas/Context missing for drawMap"); return; }

    //     const container = dom.mapCanvasContainer;
    //     if (!container) {
    //         log.error("Canvas container not found!");
    //          if (dom.canvasStatus) { dom.canvasStatus.textContent = 'Error: Container not found'; dom.canvasStatus.className = 'canvas-status error'; dom.canvasStatus.style.display = 'block'; }
    //         return;
    //     }

    //     const containerWidth = container.clientWidth;
    //     const containerHeight = container.clientHeight;
    //     log.debug(`   Canvas container dimensions: ${containerWidth}x${containerHeight}`);

    //     // --- MODIFIED: Added detailed check logging ---
    //     if (!imageMsg || typeof imageMsg !== 'object' || !imageMsg.width || !imageMsg.height || !imageMsg.encoding || !imageMsg.data) {
    //         log.warn("Invalid image message structure for drawMap:", imageMsg);
    //         if (dom.canvasStatus) { dom.canvasStatus.textContent = 'Error: Invalid map data structure'; dom.canvasStatus.className = 'canvas-status error'; dom.canvasStatus.style.display = 'block'; }
    //          if(containerWidth > 0 && containerHeight > 0) {
    //             canvas.width = containerWidth; canvas.height = containerHeight;
    //             ctx.clearRect(0, 0, canvas.width, canvas.height);
    //             log.debug("   Cleared canvas due to invalid structure.");
    //          } else {
    //              log.warn("   Cannot clear canvas, container has no dimensions.");
    //          }
    //         return;
    //     }
    //     // --- ADDED: Check if data is an array ---
    //     if (!Array.isArray(imageMsg.data)) {
    //         log.warn(`Map data field is not an array! Type: ${typeof imageMsg.data}`, imageMsg.data);
    //          if (dom.canvasStatus) { dom.canvasStatus.textContent = 'Error: Invalid map data type (expected array)'; dom.canvasStatus.className = 'canvas-status error'; dom.canvasStatus.style.display = 'block'; }
    //          if(containerWidth > 0 && containerHeight > 0) {
    //             canvas.width = containerWidth; canvas.height = containerHeight;
    //             ctx.clearRect(0, 0, canvas.width, canvas.height);
    //              log.debug("   Cleared canvas due to invalid data type.");
    //          } else {
    //               log.warn("   Cannot clear canvas, container has no dimensions.");
    //          }
    //          return;
    //     }
    //      if (containerWidth <= 0 || containerHeight <= 0) {
    //          log.warn("Canvas container has zero dimensions, skipping draw.");
    //          canvas.width = 1; canvas.height = 1; // Avoid errors with 0x0 canvas
    //          ctx.clearRect(0, 0, 1, 1);
    //          if (dom.canvasStatus) { dom.canvasStatus.textContent = 'Waiting for layout...'; dom.canvasStatus.className = 'canvas-status waiting'; dom.canvasStatus.style.display = 'block'; }
    //          return;
    //      }
    //      // --- END MODIFIED CHECKS ---

    //     const originalWidth = imageMsg.width;
    //     const originalHeight = imageMsg.height;
    //     const { encoding } = imageMsg;
    //     let { step, data: sourceData } = imageMsg;
    //     const sourceDataLength = sourceData.length; // Get length for checks
    //     log.debug(`   Image properties: ${originalWidth}x${originalHeight}, Encoding: ${encoding}, Step: ${step}, Data length: ${sourceDataLength}`);

    //     let bytesPerPixelSource = 1;
    //     if (encoding.includes('rgb') || encoding.includes('bgr') || encoding === '8UC3') bytesPerPixelSource = 3;
    //     else if (encoding.includes('rgba') || encoding.includes('bgra')) bytesPerPixelSource = 4;
    //     else if (encoding === 'mono16' || encoding === '16UC1') bytesPerPixelSource = 2;
    //     if (!step || step < originalWidth * bytesPerPixelSource) step = originalWidth * bytesPerPixelSource;
    //     log.debug(`   Calculated: bytesPerPixelSource=${bytesPerPixelSource}, step=${step}`);


    //     try {
    //         log.debug("   Creating offscreen canvas...");
    //         // === Step 1: Draw original image onto an Offscreen Canvas ===
    //         const offscreenCanvas = document.createElement('canvas');
    //         offscreenCanvas.width = originalWidth;
    //         offscreenCanvas.height = originalHeight;
    //         const offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true }); // Opt-in for performance if needed, might not be necessary
    //         if (!offscreenCtx) { throw new Error("Could not create offscreen canvas context."); }

    //         // Check if sourceData length is sufficient BEFORE creating ImageData
    //         const expectedDataLength = step * (originalHeight - 1) + originalWidth * bytesPerPixelSource;
    //         if (sourceDataLength < expectedDataLength) {
    //             log.warn(`   Source data length (${sourceDataLength}) seems too small for dimensions/step/bpp. Expected at least ${expectedDataLength}. Attempting to draw anyway.`);
    //              // Optional: Throw error here? Or let the loop handle out-of-bounds? Letting loop handle is more robust for slightly truncated data.
    //              // throw new Error(`Source data length (${sourceDataLength}) is less than expected (${expectedDataLength})`);
    //         }


    //         const offscreenImgData = offscreenCtx.createImageData(originalWidth, originalHeight);
    //         const offscreenTargetData = offscreenImgData.data;
    //         log.debug(`   Created offscreen ImageData (${offscreenTargetData.length} bytes). Starting pixel loop...`);

    //          for (let y = 0; y < originalHeight; y++) {
    //             for (let x = 0; x < originalWidth; x++) {
    //                 const targetIdx = (y * originalWidth + x) * 4; // Target is always RGBA (4 bytes)
    //                 let sourceIdx = y * step + x * bytesPerPixelSource;

    //                 // Bounds check for target (shouldn't happen if ImageData is correct size)
    //                 if (targetIdx + 3 >= offscreenTargetData.length) {
    //                     // This log indicates a potential logic error in index calculation or canvas size
    //                     log.warn(`   Pixel Loop: Target index ${targetIdx + 3} out of bounds (${offscreenTargetData.length}) at x=${x}, y=${y}. Breaking inner loop.`);
    //                     break;
    //                 }

    //                 // Bounds check for source data (CRITICAL for preventing errors)
    //                 if (sourceIdx + bytesPerPixelSource - 1 >= sourceDataLength) {
    //                      // Draw transparent pixel if source data is missing for this coordinate
    //                     offscreenTargetData[targetIdx] = 0;   // R
    //                     offscreenTargetData[targetIdx+1] = 0; // G
    //                     offscreenTargetData[targetIdx+2] = 0; // B
    //                     offscreenTargetData[targetIdx+3] = 0; // A (Transparent)
    //                     // Only log this warning once per drawMap call if it happens
    //                     if (!drawMap.sourceBoundsWarned) {
    //                          log.warn(`   Pixel Loop: Source index ${sourceIdx + bytesPerPixelSource - 1} out of bounds (${sourceDataLength}) at x=${x}, y=${y}. Filling with transparent and suppressing further warnings for this frame.`);
    //                          drawMap.sourceBoundsWarned = true;
    //                     }
    //                     continue; // Skip to next pixel
    //                 }

    //                 let r = 0, g = 0, b = 0, a = 255;
    //                  if (encoding === 'mono8' || encoding === '8UC1') r = g = b = sourceData[sourceIdx];
    //                 else if (encoding === 'rgb8') { r = sourceData[sourceIdx]; g = sourceData[sourceIdx + 1]; b = sourceData[sourceIdx + 2]; }
    //                 else if (encoding === 'bgr8' || encoding === '8UC3') { b = sourceData[sourceIdx]; g = sourceData[sourceIdx + 1]; r = sourceData[sourceIdx + 2]; }
    //                 else if (encoding === 'rgba8') { r = sourceData[sourceIdx]; g = sourceData[sourceIdx + 1]; b = sourceData[sourceIdx + 2]; a = sourceData[sourceIdx + 3]; }
    //                 else if (encoding === 'bgra8') { b = sourceData[sourceIdx]; g = sourceData[sourceIdx + 1]; r = sourceData[sourceIdx + 2]; a = sourceData[sourceIdx + 3]; }
    //                 else if (encoding === 'mono16' || encoding === '16UC1') { const pv16 = sourceData[sourceIdx] | (sourceData[sourceIdx + 1] << 8); r = g = b = Math.round(pv16 / 256); }
    //                 else {
    //                     if (!drawMap.warnedEncodings) drawMap.warnedEncodings = new Set();
    //                     if (!drawMap.warnedEncodings.has(encoding)) { log.warn(`   Unsupported canvas encoding: ${encoding}. Rendering as black. Suppressing further warnings for this encoding.`); drawMap.warnedEncodings.add(encoding); }
    //                     r = g = b = 0; a = 255;
    //                 }
    //                 offscreenTargetData[targetIdx] = r; offscreenTargetData[targetIdx + 1] = g; offscreenTargetData[targetIdx + 2] = b; offscreenTargetData[targetIdx + 3] = a;
    //             }
    //         }
    //         drawMap.sourceBoundsWarned = false; // Reset warning flag for next call
    //         log.debug("   Pixel loop finished. Putting ImageData onto offscreen canvas...");
    //         offscreenCtx.putImageData(offscreenImgData, 0, 0);

    //         // === Step 2: Rotate and Draw Scaled onto Main Canvas ===
    //         log.debug("   Resizing main canvas and clearing...");
    //         canvas.width = containerWidth;
    //         canvas.height = containerHeight;

    //         ctx.clearRect(0, 0, canvas.width, canvas.height);
    //         ctx.save();

    //          // Calculate aspect ratios and drawing dimensions
    //         const rotatedImageAspectRatio = originalHeight / originalWidth; // Aspect ratio *after* 90/-90 deg rotation
    //         const containerAspectRatio = canvas.width / canvas.height;
    //         let drawWidth, drawHeight;
    //         if (rotatedImageAspectRatio > containerAspectRatio) {
    //             // Fit to container width
    //             drawWidth = canvas.width;
    //             drawHeight = drawWidth / rotatedImageAspectRatio;
    //         } else {
    //             // Fit to container height
    //             drawHeight = canvas.height;
    //             drawWidth = drawHeight * rotatedImageAspectRatio;
    //         }
    //         log.debug(`   Calculated draw dimensions (rotated): ${drawWidth.toFixed(1)}x${drawHeight.toFixed(1)}`);


    //         // Apply transformations
    //         ctx.translate(canvas.width / 2, canvas.height / 2);
    //         const rotationAngle = -Math.PI; // -180 degrees
    //          log.debug(`   Applying rotation: ${rotationAngle} radians (${rotationAngle * 180 / Math.PI} degrees)`);
    //         ctx.rotate(rotationAngle); // Apply rotation

    //         // Draw the offscreen canvas onto the main canvas, scaled and centered
    //          log.debug("   Drawing rotated image onto main canvas...");
    //         ctx.drawImage(
    //             offscreenCanvas, // Source: the offscreen canvas with the original image
    //             0, 0, originalWidth, originalHeight, // Source rect: full original image
    //             -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight // Destination rect: scaled and centered around (0,0) after translate/rotate
    //         );

    //         ctx.restore();
    //         log.debug("   Draw complete. Hiding canvas status.");

    //         if (dom.canvasStatus) dom.canvasStatus.style.display = 'none';

    //     } catch (e) {
    //         log.error("Canvas draw error:", e);
    //         if (dom.canvasStatus) { dom.canvasStatus.textContent = `Render Error: ${e.message}`; dom.canvasStatus.className = 'canvas-status error'; dom.canvasStatus.style.display = 'block'; }
    //         // Attempt to clear canvas even on error
    //         try {
    //              if (canvas.width > 0 && canvas.height > 0) {
    //                 log.debug("   Clearing canvas after error.");
    //                 canvas.width = containerWidth; canvas.height = containerHeight; // Ensure size before clear
    //                 ctx.clearRect(0, 0, canvas.width, canvas.height);
    //              }
    //         } catch(clearErr) {
    //              log.error("   Error trying to clear canvas after draw error:", clearErr);
    //         }
    //     } finally {
    //          // Reset warned encodings flag for next call
    //          if (drawMap.warnedEncodings) drawMap.warnedEncodings = new Set();
    //     }
    // }


    // --- OpenStreetMap Updates ---
    function updateOsmMapPosition(lat, lon) {
        // Update the robot marker on the main dashboard map
        if (!osmMap) { initOsmMap(); if (!osmMap) return; }
        if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) { log.warn(`Invalid Lat/Lon for OSM update: ${lat}, ${lon}`); return; }
        const latLng = L.latLng(lat, lon);
        if (!robotMarker) {
             log.debug(`Creating OSM robot marker at ${lat}, ${lon}`);
            if (!robotIcon) defineRobotIcon();
            try { robotMarker = L.marker(latLng, { icon: robotIcon }).addTo(osmMap); osmMap.setView(latLng, Math.max(osmMap.getZoom(), 16)); } catch (e) { log.error("Error adding marker to OSM map:", e); }
        } else {
            // log.debug(`Updating OSM robot marker to ${lat}, ${lon}`); // Can be noisy
            try { robotMarker.setLatLng(latLng); } catch (e) { log.error("Error setting marker LatLng on OSM map:", e); }
        }
    }

    function debouncedUpdateOsmMapPosition(lat, lon) {
        // Debounce OSM map updates to avoid excessive redraws
        clearTimeout(mapUpdateTimer);
        mapUpdateTimer = setTimeout(() => { updateOsmMapPosition(lat, lon); }, MAP_UPDATE_DEBOUNCE);
    }

    function updateOsmMapPositionFromStatus() {
        // Get position from latestData and call debounced update
        if (!selectedRobot || !osmMap) return;
        const statusData = latestData[selectedRobot]?.topics?.['robot_status']?.payload;
        if (statusData?.gps?.latitude && statusData?.gps?.longitude) {
            // log.debug("Updating OSM map position from robot_status"); // Can be noisy
            debouncedUpdateOsmMapPosition(statusData.gps.latitude, statusData.gps.longitude);
        } else {
             // log.debug("No GPS data in robot_status to update OSM map"); // Can be noisy
        }
    }

    function updateGpsPathFromState(mapInstance, mapType) {
        // Update GPS path polyline from latest data
        if (!selectedRobot || !mapInstance) return;
        const pathData = latestData[selectedRobot]?.topics?.['gloal_path_gps']?.payload;
        drawGpsPath(pathData, mapInstance, mapType);
    }

    // --- Controller Map Logic ---
    function centerControllerMapOnRobot() {
        // Center the controller map on the robot's current position
        if (!controllerMapInstance) { initControllerMap(); if (!controllerMapInstance) return; }
        const statusData = latestData[selectedRobot]?.topics?.['robot_status']?.payload;
        let centerPos = DEFAULT_MAP_CENTER; let zoomLevel = DEFAULT_MAP_ZOOM;
        if (selectedRobot && statusData?.gps?.latitude && statusData?.gps?.longitude) {
            centerPos = [statusData.gps.latitude, statusData.gps.longitude];
            zoomLevel = CONTROLLER_MAP_ZOOM;
        }
         log.debug(`Centering controller map on [${centerPos.join(', ')}] zoom ${zoomLevel}`);
        controllerMapInstance.setView(centerPos, zoomLevel);
    }

    function updateControllerMapRobotMarker() {
        // Update the robot marker position/visibility on the controller map
        if (!controllerMapInstance || !controllerRobotMarker || !selectedRobot) return;
        const statusData = latestData[selectedRobot]?.topics?.['robot_status']?.payload;
        if (statusData?.gps?.latitude && statusData?.gps?.longitude) {
            const latLng = L.latLng(statusData.gps.latitude, statusData.gps.longitude);
            try {
                 controllerRobotMarker.setLatLng(latLng).setOpacity(1.0);
                 // log.debug("Updated controller map robot marker position"); // Noisy
            } catch (e) { log.error("Err set controller marker pos:", e); }
        } else {
            // log.debug("Hiding controller map robot marker (no GPS)"); // Noisy
            controllerRobotMarker.setOpacity(0); // Hide if no GPS
        }
    }

    function updateControllerMapRoute() {
        // Update the path polyline on the controller map
        updateGpsPathFromState(controllerMapInstance, 'controller');
    }

    function handleControllerMapClick(e) {
        // Handle clicks on the controller map for adding points
        const clickedLatLng = e.latlng;
        if (!currentSelectionMode) { setMapSelectionStatus("Click 'Add Store Point' or 'Set Final Customer' first!"); return; }
        if (sequenceActive) { setMapSelectionStatus("Cannot modify points while sequence is active."); return; }

        log.info(`Map clicked at ${clickedLatLng.lat.toFixed(6)}, ${clickedLatLng.lng.toFixed(6)} for mode: ${currentSelectionMode}`);
        if (currentSelectionMode === 'addStore') {
            addStorePoint(clickedLatLng);
            setMapSelectionStatus(`Store point ${storePointsSequence.length} added. Click map for next, or set Customer/Start.`);
            // Keep 'addStore' mode active
        } else if (currentSelectionMode === 'customer') {
            customerLatLng = clickedLatLng;
            updateMarker(customerMarker, customerLatLng, true); // Show marker
            updateCoordsDisplay('customer', customerLatLng);
            updateReadonlyInputs('customer', customerLatLng);
            setMapSelectionStatus(`Final Customer location set at ${clickedLatLng.lat.toFixed(5)}, ${clickedLatLng.lng.toFixed(5)}.`);
            setActiveButton(dom.selectCustomerBtn, false); // Deactivate button highlight
            currentSelectionMode = null; // Exit selection mode
            updateSequenceControlButtonStates(); // Re-evaluate start button state now customer is set
        }
    }

    function handleMarkerDragEnd(e, type) {
        // Handle marker drag events (store points or customer)
        if (sequenceActive) { // Prevent dragging during active sequence
            log.warn("Attempted to drag marker while sequence active. Resetting.");
            const marker = e.target;
            let originalLatLng = null;
            if (type === 'customer') originalLatLng = customerLatLng;
            else if (type.startsWith('store-')) {
                const index = parseInt(type.split('-')[1], 10);
                if (!isNaN(index) && storePointsSequence[index]) originalLatLng = storePointsSequence[index].latlng;
            }
            if (originalLatLng) marker.setLatLng(originalLatLng); // Reset position
            return;
        }

        const marker = e.target;
        const newLatLng = marker.getLatLng();
        if (type === 'customer') {
            log.info(`Customer marker dragged to: ${newLatLng.lat.toFixed(6)}, ${newLatLng.lng.toFixed(6)}`);
            customerLatLng = newLatLng;
            updateCoordsDisplay('customer', newLatLng);
            updateReadonlyInputs('customer', newLatLng);
            setMapSelectionStatus(`Customer location updated by dragging.`);
             updateSequenceControlButtonStates(); // Re-evaluate start button state
        } else if (type.startsWith('store-')) {
            const index = parseInt(type.split('-')[1], 10);
            if (!isNaN(index) && storePointsSequence[index]) {
                log.info(`Store point ${index + 1} dragged to: ${newLatLng.lat.toFixed(6)}, ${newLatLng.lng.toFixed(6)}`);
                storePointsSequence[index].latlng = newLatLng;
                renderSequenceList(); // Update list display
                setMapSelectionStatus(`Store point ${index + 1} location updated by dragging.`);
            } else {
                log.warn(`Could not find store point for drag event type: ${type}`);
            }
        }
    }

    function updateMarker(marker, latLng, makeVisible) {
        // Helper to update marker position and visibility
        if (!marker) return;
        try {
            if (latLng) {
                 marker.setLatLng(latLng);
                 if (makeVisible !== undefined) marker.setOpacity(makeVisible ? 1.0 : 0);
            } else {
                 marker.setOpacity(0); // Hide if no LatLng provided
            }
        } catch (e) { log.error("Error updating marker:", e); }
    }

    function updateCoordsDisplay(type, latLng) {
        // Update the text display for target/customer coordinates
        const spanElement = (type === 'target') ? dom.targetCoordsSpan : dom.customerCoordsSpan;
        const defaultText = (type === 'target') ? "N/A" : "Not Set";
        if (spanElement) {
            spanElement.textContent = latLng ? `${latLng.lat.toFixed(6)}, ${latLng.lng.toFixed(6)}` : defaultText;
        }
    }

    function updateReadonlyInputs(type, latLng) {
        // Update the readonly input fields for customer lat/lon/z
        if (type !== 'customer') return;
        if (dom.srvCustLatInput && dom.srvCustLonInput && dom.srvCustZInput) {
            dom.srvCustLatInput.value = latLng ? latLng.lat.toFixed(7) : "0.0";
            dom.srvCustLonInput.value = latLng ? latLng.lng.toFixed(7) : "0.0";
            // Only update Z if it's default, otherwise preserve user input? For now, just set if LatLng exists.
            dom.srvCustZInput.value = latLng ? (dom.srvCustZInput.value || "0.0") : "0.0";
        }
    }

    function setMapSelectionStatus(text) {
        // Update the small status text near map selection buttons
        if (dom.mapSelectionStatus) dom.mapSelectionStatus.textContent = text;
    }

    function setActiveButton(activeBtn, isActive) {
        // Visually highlight the active map selection button ('Add Store' or 'Set Customer')
        if (dom.addStorePointBtn) dom.addStorePointBtn.classList.remove('active-selection');
        if (dom.selectCustomerBtn) dom.selectCustomerBtn.classList.remove('active-selection');
        if (isActive && activeBtn) activeBtn.classList.add('active-selection');
    }

    function updateStoredMarkerPositions() {
        // Ensure markers (customer, store points) are correctly positioned on map init/robot change
        updateMarker(customerMarker, customerLatLng, customerLatLng !== null);
        storePointsSequence.forEach(point => {
            updateMarker(point.marker, point.latlng, true); // Assume store points always visible if they exist
            // Re-attach drag handler (might be lost on complex updates, though unlikely needed here)
            if (point.marker && point.dragHandler) {
                 point.marker.off('dragend', point.dragHandler).on('dragend', point.dragHandler);
            }
        });
    }

    // --- Sequence Functions ---
    function addStorePoint(latlng) {
        // Add a new store point to the sequence
        if (!controllerMapInstance || sequenceActive) return; // Prevent adding during active sequence
        const index = storePointsSequence.length;
         log.info(`Adding store point ${index + 1} at ${latlng.lat}, ${latlng.lng}`);
        const newMarker = L.marker(latlng, { draggable: true, title: `Store Point ${index + 1}` })
            .addTo(controllerMapInstance).bindPopup(`Store Point ${index + 1}`);
        const dragHandler = (e) => handleMarkerDragEnd(e, `store-${index}`);
        newMarker.on('dragend', dragHandler);
        storePointsSequence.push({ latlng, marker: newMarker, status: 'pending', dragHandler });
        renderSequenceList();
        updateSequenceControlButtonStates();
    }

    function deleteStorePoint(index) {
        // Delete a store point from the sequence
        if (sequenceActive || index < 0 || index >= storePointsSequence.length) return;
        log.info(`Deleting store point ${index + 1}`);
        const pointToRemove = storePointsSequence[index];
        if (pointToRemove.marker) { // Clean up map marker
            try { pointToRemove.marker.off('dragend', pointToRemove.dragHandler); pointToRemove.marker.remove(); } catch (e) { log.error("Marker remove error:", e); }
        }
        storePointsSequence.splice(index, 1); // Remove from array
        // Update subsequent marker indices/handlers
        storePointsSequence.forEach((point, i) => {
            if (i >= index && point.marker) {
                 log.debug(`Updating marker index/handler for point ${i+1} after deletion.`);
                const newType = `store-${i}`;
                point.marker.off('dragend', point.dragHandler); // Remove old
                point.dragHandler = (e) => handleMarkerDragEnd(e, newType); // Create new
                point.marker.on('dragend', point.dragHandler);
                point.marker.bindPopup(`Store Point ${i + 1}`);
                point.marker.options.title = `Store Point ${i + 1}`;
            }
        });
        renderSequenceList();
        updateSequenceControlButtonStates();
        // Clear target display if the deleted point was the target
        if (!sequenceActive && dom.targetCoordsSpan && pointToRemove.latlng && dom.targetCoordsSpan.textContent.startsWith(pointToRemove.latlng.lat.toFixed(5))) {
            updateCoordsDisplay('target', null);
        }
    }

    function renderSequenceList() {
        // Update the visual list of sequence points
        if (!dom.sequencePointsListElement) return;
        dom.sequencePointsListElement.innerHTML = ''; // Clear
        if (storePointsSequence.length === 0) {
            dom.sequencePointsListElement.innerHTML = '<p class="waiting">Add delivery points using the map buttons and clicking the map.</p>';
            return;
        }
        storePointsSequence.forEach((point, index) => {
            const item = document.createElement('div');
            item.className = `sequence-item status-${point.status}`;
            item.dataset.index = index; // Store index for deletion
            item.innerHTML = `
                <div>
                    <span class="seq-item-index">${index + 1}.</span>
                    <span class="seq-item-coords">${point.latlng.lat.toFixed(5)}, ${point.latlng.lng.toFixed(5)}</span>
                </div>
                <button class="seq-item-delete-btn" title="Delete Point ${index + 1}" ${sequenceActive ? 'disabled' : ''}>
                    <i class="fas fa-times"></i>
                </button>`;
            dom.sequencePointsListElement.appendChild(item);
        });
        dom.sequencePointsListElement.classList.toggle('sequence-active', sequenceActive); // CSS can hide delete buttons
         // log.debug("Rendered sequence list."); // Can be noisy
    }

    function updateSequenceControlButtonStates() {
        // Enable/disable sequence control buttons based on current state
        const hasPoints = storePointsSequence.length > 0;
        const isOnline = selectedRobot && robotStatus[selectedRobot] === 'online';
        const customerSet = customerLatLng !== null; // Explicit check for customer point

        // -- DETAILED LOGGING FOR START BUTTON --
        // log.debug(`Update Sequence Buttons State: sequenceActive=${sequenceActive}, hasPoints=${hasPoints} (${storePointsSequence.length}), isOnline=${isOnline} (robot: ${selectedRobot}, status: ${robotStatus[selectedRobot]}), customerSet=${customerSet}`);
        // -- END DETAILED LOGGING --

        if (dom.startSequenceBtn) {
             const shouldBeDisabled = sequenceActive || !hasPoints || !isOnline || !customerSet;
             // Log the reason if disabled (only if state changes potentially)
             // if(dom.startSequenceBtn.disabled !== shouldBeDisabled && shouldBeDisabled) {
             //      let reasons = [];
             //      if(sequenceActive) reasons.push("sequence active");
             //      if(!hasPoints) reasons.push("no store points");
             //      if(!isOnline) reasons.push("robot offline/waiting");
             //      if(!customerSet) reasons.push("customer not set");
             //      log.debug(`Start button DISABLED because: ${reasons.join(', ')}`);
             // } else if (dom.startSequenceBtn.disabled !== shouldBeDisabled && !shouldBeDisabled) {
             //      log.debug("Start button ENABLED.");
             // }
             dom.startSequenceBtn.disabled = shouldBeDisabled;
        }
        if (dom.stopSequenceBtn) dom.stopSequenceBtn.disabled = !sequenceActive;
        if (dom.clearSequenceBtn) dom.clearSequenceBtn.disabled = sequenceActive || !hasPoints;

        // Map interaction buttons
        const disableMapButtons = sequenceActive || !isOnline;
        if (dom.addStorePointBtn) dom.addStorePointBtn.disabled = disableMapButtons;
        if (dom.selectCustomerBtn) dom.selectCustomerBtn.disabled = disableMapButtons;

        // Marker dragging
        const allowDragging = !sequenceActive;
        storePointsSequence.forEach(p => p.marker?.dragging?.[allowDragging ? 'enable' : 'disable']());
        customerMarker?.dragging?.[allowDragging ? 'enable' : 'disable']();

        // Visual cue on list container
        if (dom.sequencePointsListElement) dom.sequencePointsListElement.classList.toggle('sequence-active', sequenceActive);
    }

    function setSequenceStatusMessage(message, type = 'info') {
        // Update the status message area for the sequence
        if (!dom.sequenceStatusElement) return;
        dom.sequenceStatusElement.textContent = message;
        const validTypes = ['info', 'success', 'warning', 'error'];
        const safeType = validTypes.includes(type) ? type : 'info';
        dom.sequenceStatusElement.className = `status-message ${safeType}`;
        dom.sequenceStatusElement.style.display = message ? 'block' : 'none';
        log.debug(`Sequence Status: [${type}] ${message}`);
    }

    function startSequence() {
        // Start the delivery sequence process
        // Guard clauses first
        if (sequenceActive) { log.warn("Start ignored: Sequence already active."); return; }
        if (storePointsSequence.length === 0) { showCommandFeedback('warning', 'Cannot start: No store points added.'); return; }
        if (!selectedRobot || robotStatus[selectedRobot] !== 'online') { showCommandFeedback('warning', 'Cannot start: Robot not selected or not online.'); return; }
        if (!customerLatLng) {
            showCommandFeedback('warning', 'Cannot start: Final Customer location not set on the map.');
            setActiveButton(dom.selectCustomerBtn, true); // Highlight button
            setMapSelectionStatus("Click map to set FINAL Customer...");
            currentSelectionMode = 'customer';
            return;
        }

        log.info(`Starting delivery sequence with ${storePointsSequence.length} points.`);
        sequenceActive = true;
        currentSequenceIndex = 0; // Start at the first point
        storePointsSequence.forEach(p => p.status = 'pending'); // Reset all statuses

        sendTargetPointCommand(); // Send command for the first point
        updateSequenceControlButtonStates(); // Update button states (disable start, enable stop)
        setSequenceStatusMessage(`Sequence started. Targeting Point 1/${storePointsSequence.length}.`, 'info');
        clearCommandFeedback(); // Clear old feedback
    }

    function stopSequence(reason = "stopped") { // Reasons: "stopped", "finished", "error", "cleared"
        // Stop the active sequence
        if (!sequenceActive) return;
        log.info(`Stopping sequence. Reason: ${reason}`);
        sequenceActive = false;
        const stoppedIndex = currentSequenceIndex; // Keep track of where we stopped
        currentSequenceIndex = -1;

        // Update UI
        storePointsSequence.forEach(p => { if (p.status === 'target') p.status = 'pending'; }); // Revert target to pending unless finished
        if(reason === 'finished') storePointsSequence.forEach(p => p.status = 'done'); // Mark all done if finished ok
        renderSequenceList();
        updateCoordsDisplay('target', null); // Clear target display
        updateSequenceControlButtonStates(); // Update button states

        // Set final status message
        if (reason === 'finished') setSequenceStatusMessage(`Sequence successfully completed all ${storePointsSequence.length} points!`, 'success');
        else if (reason === 'error') setSequenceStatusMessage(`Sequence stopped due to error${stoppedIndex > -1 ? ` at point ${stoppedIndex + 1}` : ''}.`, 'error');
        else if (reason === 'cleared') setSequenceStatusMessage("Sequence cleared.", 'info');
        else setSequenceStatusMessage("Sequence stopped by user.", 'warning'); // Default 'stopped'

        // Maybe send a final 'deactivate' command (depends on robot logic)
         // const payload = { operation_mode: 0, drive_tele_mode: false, /*...*/ };
         //        socket.emit('send_command', { robot_id: selectedRobot, command_type: 'server_cmd', payload });
    }

    function clearSequence() {
        // Clear all points and reset sequence state
        if (sequenceActive) stopSequence("cleared"); // Stop if running
        log.info("Clearing sequence list and markers.");
        storePointsSequence.forEach(p => p.marker?.remove()); // Remove markers
        storePointsSequence = []; // Empty array
        currentSequenceIndex = -1;
        // Do NOT clear customerLatLng automatically, user might want to reuse it
        renderSequenceList(); // Update UI list
        updateSequenceControlButtonStates();
        setSequenceStatusMessage("", 'info'); // Clear status message
        updateCoordsDisplay('target', null); // Clear target display
    }

    function sendTargetPointCommand() {
        // Send the command for the current target point in the sequence
        if (!sequenceActive || currentSequenceIndex < 0 || currentSequenceIndex >= storePointsSequence.length) {
            log.error("Send target failed: Sequence inactive or index invalid.");
            stopSequence("error"); return;
        }
        if (!selectedRobot || robotStatus[selectedRobot] !== 'online') {
            log.warn(`Robot '${selectedRobot}' offline. Stopping sequence.`); stopSequence("error");
            showCommandFeedback('error', `Robot offline. Sequence stopped.`); return;
        }
        if (!customerLatLng) { // Should be caught by startSequence, but double-check
            log.error("Customer location missing sending target command."); stopSequence("error");
            showCommandFeedback('error', "Customer location missing. Sequence stopped."); return;
        }

        const targetPoint = storePointsSequence[currentSequenceIndex];
        targetPoint.status = 'target'; // Mark as target
        renderSequenceList(); // Update UI
        updateCoordsDisplay('target', targetPoint.latlng); // Update target display

        // Prepare payload
        const storeLoc = { x: targetPoint.latlng.lat, y: targetPoint.latlng.lng, z: 0.0 };
        const customerLoc = { x: customerLatLng.lat, y: customerLatLng.lng, z: parseFloat(dom.srvCustZInput?.value) || 0.0 };

        const payload = {
            operation_mode: getControllerValue(dom.srvOpModeSelect, 'select_int'),
            drive_tele_mode: getControllerValue(dom.srvDriveTeleBtn, 'boolean') ? 1 : 0,
            server_cmd_state: 2, // 2 = gửi vị trí mới, 5 = hủy
            confirmation: 0, // Robot sets this on arrival
            store_location: storeLoc,
            customer_location: customerLoc, // Send final customer with each point
            open_lid_cmd: getControllerValue(dom.srvOpenLidBtn, 'boolean') ? 1 : 0,
            emb_map: getControllerValue(dom.srvEmbMapInput, 'string') || "OCP",
            tele_cmd_vel: buildNestedObject('.input-group.twist-group', 'tele_cmd_vel', '.server-command-col-left')
        };

        log.info(`Sending Sequence Command Point ${currentSequenceIndex + 1}/${storePointsSequence.length} to ${selectedRobot}`);
        log.debug("Sequence Payload:", JSON.stringify(payload)); // Log the actual payload
        socket.emit('send_command', { robot_id: selectedRobot, command_type: 'server_cmd', payload });
        setSequenceStatusMessage(`Sent Point ${currentSequenceIndex + 1}. Waiting for arrival confirmation...`, 'info');
    }

    function handleArrivalConfirmation() {
        // Handle confirmation message (confirmation=3) from robot_status
        if (!sequenceActive || currentSequenceIndex < 0 || currentSequenceIndex >= storePointsSequence.length) {
            log.warn("Arrival confirmation received but sequence state invalid."); return;
        }
        log.info(`Arrival confirmed for Point ${currentSequenceIndex + 1}!`);
        storePointsSequence[currentSequenceIndex].status = 'done';
        renderSequenceList();
        currentSequenceIndex++; // Advance index
        if (currentSequenceIndex < storePointsSequence.length) { // More points left
            log.info(`Advancing to Point ${currentSequenceIndex + 1}`);
            setSequenceStatusMessage(`Arrived Point ${currentSequenceIndex}. Sending next target...`, 'info'); // Index already incremented
            sendTargetPointCommand(); // Send next command
        } else { // Last point completed
            log.info("All sequence points completed!");
            stopSequence("finished");
        }
    }

    // --- GPS Path Drawing ---
    function drawGpsPath(pathData, mapInstance, mapType) {
        // Draw GPS path polyline on the specified map
        if (!mapInstance) return;

        let currentPolyline = (mapType === 'controller') ? controllerPathPolyline : dashboardPathPolyline;

        // Clear existing path first
        if (currentPolyline) {
             try {
                 // log.debug(`GPS Path (${mapType}): Removing old polyline.`); // Noisy
                 currentPolyline.remove();
             } catch(e) { log.warn(`Error removing old ${mapType} polyline:`, e); }
             currentPolyline = null; // Ensure reference is cleared after removal
        }

        // --- FIX: Explicitly handle the "waiting..." placeholder ---
        if (!pathData || pathData === "waiting...") {
            log.debug(`GPS Path (${mapType}): No valid path data or waiting (received: ${pathData}). Path cleared.`);
            // Update the stored reference after removal/clearing
            if (mapType === 'controller') controllerPathPolyline = null;
            else dashboardPathPolyline = null;
            return; // Exit the function early
        }
        // --- END FIX ---

        // If we reach here, pathData is assumed to be actual data needing processing.
        let points = [];
        let structureType = "unknown";

        try { // Add try block for robustness during path parsing
             if (pathData && Array.isArray(pathData.poses)) { // geometry_msgs/PoseStamped array
                structureType = "PoseStamped[]";
                points = pathData.poses // Access the 'poses' array
                               .map(p => p?.pose?.position) // Extract position
                               .filter(pos => pos && typeof pos.x === 'number' && typeof pos.y === 'number') // Validate
                               .map(pos => [pos.x, pos.y]); // Assume x=lat, y=lon (CHECK THIS ASSUMPTION)
            } else if (Array.isArray(pathData)) { // sensor_msgs/NavSatFix array OR simple [lat,lon] array
                 // Check first element to guess structure
                 if (pathData.length > 0 && typeof pathData[0] === 'object' && pathData[0] !== null && 'latitude' in pathData[0] && 'longitude' in pathData[0]) {
                      structureType = "NavSatFix[]";
                      points = pathData.map(p => (p && typeof p.latitude === 'number' && typeof p.longitude === 'number') ? [p.latitude, p.longitude] : null)
                                       .filter(p => p !== null);
                 } else if (pathData.length > 0 && Array.isArray(pathData[0]) && pathData[0].length >= 2 && typeof pathData[0][0] === 'number' && typeof pathData[0][1] === 'number') {
                      structureType = "[lat,lon][]";
                      points = pathData.filter(p => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number')
                                       .map(p => [p[0], p[1]]); // Take only first two elements
                 } else {
                      structureType = "Unknown Array";
                       log.warn(`GPS Path (${mapType}): Data is an array, but elements are not NavSatFix-like or [lat,lon]-like. First element:`, pathData[0]);
                 }

            } else if (pathData && typeof pathData === 'object' && Array.isArray(pathData.routes)) { // Custom structure with 'routes' array
                structureType = "Custom routes[]";
                points = pathData.routes
                    .map(p => {
                        if (p && typeof p.latitude === 'number' && typeof p.longitude === 'number') {
                            return [p.latitude, p.longitude];
                        }
                        else if (p && typeof p.x === 'number' && typeof p.y === 'number') {
                             // log.debug(`GPS Path (${mapType}): Using x,y from routes point.`); // Noisy
                            return [p.x, p.y]; // Assume x=lat, y=lon (CHECK THIS)
                        }
                        else {
                            log.warn(`GPS Path (${mapType}): Skipping invalid point in routes array:`, p);
                            return null;
                        }
                    })
                    .filter(p => p !== null);
            } else {
                log.warn(`Unrecognized GPS path data structure for ${mapType}: Type=${typeof pathData}`, pathData);
            }
        } catch (parseError) {
             log.error(`Error parsing GPS path data (${mapType}, Structure: ${structureType}):`, parseError, "Data:", pathData);
             points = []; // Ensure points is empty on error
        }


        if (points.length > 1) {
            try {
                const color = (mapType === 'controller') ? '#FF00FF' : '#0000FF'; // Magenta or Blue
                const weight = (mapType === 'controller') ? 4 : 3;
                 log.debug(`GPS Path (${mapType}): Drawing polyline with ${points.length} points. Structure: ${structureType}`);
                currentPolyline = L.polyline(points, { color, weight, opacity: 0.7 }).addTo(mapInstance);
            } catch (e) {
                log.error(`Error drawing ${mapType} polyline:`, e);
                currentPolyline = null; // Reset on error
            }
        } else {
             log.debug(`GPS Path (${mapType}): Not enough valid points to draw polyline (${points.length}). Structure: ${structureType}`);
             currentPolyline = null; // Ensure reference is null if no points are drawn
        }

        // Store reference (currentPolyline might be null or the new polyline instance)
        if (mapType === 'controller') controllerPathPolyline = currentPolyline;
        else dashboardPathPolyline = currentPolyline;
    }


    // --- Map Interaction Handlers ---
    function handleAddStorePointClick() {
        // Kích hoạt chế độ thêm store point
        if (sequenceActive) {
            showCommandFeedback('warning', 'Cannot add store points while sequence is active.');
            return;
        }
        
        if (!selectedRobot || robotStatus[selectedRobot] !== 'online') {
            showCommandFeedback('warning', 'Robot must be online to add store points.');
            return;
        }
        
        log.info('Add Store Point mode activated.');
        currentSelectionMode = 'addStore';
        setActiveButton(dom.addStorePointBtn, true);
        setActiveButton(dom.selectCustomerBtn, false);
        setMapSelectionStatus('Click on the map to add a store point.');
        
        // Khởi tạo controller map nếu chưa có
        if (!controllerMapInstance) {
            initControllerMap();
        }
    }

    function handleSelectCustomerClick() {
        // Kích hoạt chế độ chọn customer location
        if (sequenceActive) {
            showCommandFeedback('warning', 'Cannot set customer location while sequence is active.');
            return;
        }
        
        if (!selectedRobot || robotStatus[selectedRobot] !== 'online') {
            showCommandFeedback('warning', 'Robot must be online to set customer location.');
            return;
        }
        
        log.info('Select Customer mode activated.');
        currentSelectionMode = 'customer';
        setActiveButton(dom.selectCustomerBtn, true);
        setActiveButton(dom.addStorePointBtn, false);
        setMapSelectionStatus('Click on the map to set final customer location.');
        
        // Khởi tạo controller map nếu chưa có
        if (!controllerMapInstance) {
            initControllerMap();
        }
    }

    // --- View Navigation ---
    function setupEventListeners() {
        // Setup all event listeners for UI elements
        dom.sidebarNavItems.forEach(item => item.addEventListener('click', () => showView(item.getAttribute('data-view'))));
        dom.robotSelector.addEventListener('change', (event) => selectRobot(event.target.value));
        dom.toggleBtns.forEach(btn => btn.addEventListener('click', handleToggleButtonClick));
        if (dom.sendJoystickCmdBtn) dom.sendJoystickCmdBtn.addEventListener('click', sendJoystickCommand);
        if (dom.testServerCmdBtn) dom.testServerCmdBtn.addEventListener('click', sendTestServerCommand);
        // Quick Commands
        if (dom.quickNavBtn) dom.quickNavBtn.addEventListener('click', sendQuickNavCommand);
        if (dom.emergencyStopBtn) dom.emergencyStopBtn.addEventListener('click', sendEmergencyStop);
        if (dom.cancelMissionBtn) dom.cancelMissionBtn.addEventListener('click', sendCancelMission);
        
        // Quick nav inputs - Enter key support
        if (dom.quickLatInput) dom.quickLatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendQuickNavCommand();
        });
        if (dom.quickLonInput) dom.quickLonInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendQuickNavCommand();
        });
        // Sequence control buttons
        if (dom.startSequenceBtn) dom.startSequenceBtn.addEventListener('click', startSequence);
        if (dom.stopSequenceBtn) dom.stopSequenceBtn.addEventListener('click', () => stopSequence("stopped"));
        if (dom.clearSequenceBtn) dom.clearSequenceBtn.addEventListener('click', clearSequence);
        // Sequence list delete button (delegation)
        if (dom.sequencePointsListElement) {
            dom.sequencePointsListElement.addEventListener('click', (event) => {
                const deleteButton = event.target.closest('.seq-item-delete-btn');
                if (deleteButton && !deleteButton.disabled) {
                    const itemElement = deleteButton.closest('.sequence-item');
                    if (itemElement?.dataset.index !== undefined) {
                        const indexToDelete = parseInt(itemElement.dataset.index, 10);
                        if (!isNaN(indexToDelete)) deleteStorePoint(indexToDelete);
                    }
                }
            });
        }
        // Map interaction buttons
        if (dom.addStorePointBtn) dom.addStorePointBtn.addEventListener('click', handleAddStorePointClick);
        if (dom.selectCustomerBtn) dom.selectCustomerBtn.addEventListener('click', handleSelectCustomerClick);
         log.debug("Event listeners set up.");
    }

    function showView(viewId) {
        // Switch the main content view
        if (!viewId || currentView === viewId) return;
        log.info("Switching view to:", viewId);
        currentView = viewId;
        dom.contentViews.forEach(view => view.classList.remove('active'));
        const activeView = document.getElementById(viewId);
        if (activeView) activeView.classList.add('active');
        else { log.error(`View ID "${viewId}" NF! Fallback.`); document.getElementById('dashboard-view')?.classList.add('active'); currentView = 'dashboard-view'; viewId = 'dashboard-view'; }
        dom.sidebarNavItems.forEach(item => item.classList.toggle('active', item.getAttribute('data-view') === viewId));
        // View-specific actions
        if (viewId === 'dashboard-view') {
            if (selectedRobot && selectedSubTopic) {
                 log.debug("showView (dashboard): Re-configuring layout and rendering data.");
                 configureLayoutForTopic(selectedSubTopic); // Re-apply layout
                 renderData(); // Re-render data
             } else {
                 log.debug("showView (dashboard): No robot/topic selected, calling renderData for status.");
                 renderData(); // Show default message if no topic
             }
             // Invalidate map size AFTER layout is applied and map is potentially visible
            if (osmMap && (selectedSubTopic === 'routed_map' || selectedSubTopic === 'gloal_path_gps')) {
                setTimeout(() => {
                     log.debug("showView (dashboard): Invalidating OSM map size.");
                     osmMap.invalidateSize();
                }, 50);
            }
        } else if (viewId === 'controller-view') {
             log.debug("showView (controller): Initializing/updating controller map and state.");
            initControllerMap(); // Ensure map exists
            checkAllRobotStatuses(); // Update enable/disable state
            // Update map elements
            centerControllerMapOnRobot();
            updateControllerMapRobotMarker();
            updateControllerMapRoute();
            updateStoredMarkerPositions(); // Ensure markers visible
            renderSequenceList();
            updateSequenceControlButtonStates();
            if (controllerMapInstance) {
                setTimeout(() => {
                    log.debug("showView (controller): Invalidating controller map size.");
                    controllerMapInstance.invalidateSize();
                 }, 50); // Redraw map
             }
        }
        // Handle other views if added
    }

    // --- Controller Command Helpers & Sending ---
    function getControllerValue(element, type = 'string') {
        // Get value from form elements (robust)
        if (!element) { log.warn(`getControllerValue null element, type ${type}`); return (type === 'boolean' ? false : (type.includes('int') || type === 'float' ? 0 : '')); }
        try {
            if (type === 'boolean') return element.classList.contains('toggle-btn') ? element.classList.contains('on') : element.checked;
            else if (type === 'float') return parseFloat(element.value) || 0.0;
            else if (type === 'int' || type === 'select_int') return parseInt(element.value, 10) || 0;
            else return element.value || '';
        } catch (e) { log.error(`Error getting value ${element.id}, type ${type}:`, e); return (type === 'boolean' ? false : (type.includes('int') || type === 'float' ? 0 : '')); }
    }

    function buildNestedObject(parentSelector, parentKey, scopeSelector = null) {
        // Build nested JS object from inputs with data-parent/data-subfield attributes
        const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
        if (!scope) { log.warn(`Scope "${scopeSelector}" NF buildNestedObject`); return {}; }
        const inputs = scope.querySelectorAll(`${parentSelector} [data-parent="${parentKey}"]`);
        const nestedObj = {};
        inputs.forEach(input => {
            const subfieldPath = input.dataset.subfield; if (!subfieldPath) { log.warn(`Input ${input.id} missing data-subfield.`); return; }
            let valueType = input.type === 'number' ? 'float' : 'string';
            const value = getControllerValue(input, valueType);
            const parts = subfieldPath.split('.'); let currentLevel = nestedObj;
            for (let i = 0; i < parts.length - 1; i++) {
                const part = parts[i]; if (!currentLevel[part]) currentLevel[part] = {}; else if (typeof currentLevel[part] !== 'object') { log.warn(`Conflict buildNestedObject: "${part}" not object.`); currentLevel[part] = {}; } currentLevel = currentLevel[part];
            }
            currentLevel[parts[parts.length - 1]] = value;
        });
        // log.debug(`Built nested object for key "${parentKey}":`, nestedObj); // Can be noisy
        return nestedObj;
    }

    function handleToggleButtonClick(event) {
        // Handle clicks on ON/OFF toggle buttons
        const button = event.target.closest('.toggle-btn'); if (!button || button.disabled) return;
        const isCurrentlyOn = button.classList.contains('on');
        button.classList.toggle('on', !isCurrentlyOn); button.classList.toggle('off', isCurrentlyOn);
        button.textContent = isCurrentlyOn ? 'OFF' : 'ON';
        log.debug(`Toggle button clicked: field=${button.dataset.field || button.id}, newState=${!isCurrentlyOn ? 'ON' : 'OFF'}`);
    }

    // --- Command Feedback ---
    function showCommandFeedback(type, message) {
        // Display feedback messages (success, error, etc.)
        if (!dom.cmdFeedbackArea) return;
        const feedbackId = `feedback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const messageDiv = document.createElement('div');
        const validTypes = ['info', 'success', 'warning', 'error'];
        const safeType = validTypes.includes(type) ? type : 'info';
        messageDiv.className = `status-message ${safeType}`;
        messageDiv.textContent = message; messageDiv.id = feedbackId;
        messageDiv.style.display = 'block'; messageDiv.style.opacity = '1';
        messageDiv.style.transition = 'opacity 0.5s ease-out';
        dom.cmdFeedbackArea.prepend(messageDiv); // Add to top
        if (feedbackClearTimers[feedbackId]) clearTimeout(feedbackClearTimers[feedbackId]);
        feedbackClearTimers[feedbackId] = setTimeout(() => { // Auto-clear
            const msgToRemove = document.getElementById(feedbackId);
            if (msgToRemove) {
                msgToRemove.style.opacity = '0';
                setTimeout(() => { if (msgToRemove?.parentNode === dom.cmdFeedbackArea) dom.cmdFeedbackArea.removeChild(msgToRemove); delete feedbackClearTimers[feedbackId]; }, 500);
            } else { delete feedbackClearTimers[feedbackId]; }
        }, FEEDBACK_CLEAR_DELAY);
    }

    function clearCommandFeedback() {
        // Clear all messages from the feedback area
        if (dom.cmdFeedbackArea) dom.cmdFeedbackArea.innerHTML = '';
        Object.values(feedbackClearTimers).forEach(timerId => clearTimeout(timerId));
        feedbackClearTimers = {};
        log.debug('Command feedback area cleared.');
    }

    // --- Send Command Functions ---
    function sendJoystickCommand() {
        // Send the joystick control command
        if (!selectedRobot || robotStatus[selectedRobot] !== 'online') { showCommandFeedback('warning', 'Joystick: Robot not selected or offline.'); return; }
        log.info(`Sending Joystick Command for robot ${selectedRobot}`);
        const payload = {
            e_stop: getControllerValue(document.getElementById('joy-estop'), 'boolean'),
            joy_ready: getControllerValue(document.getElementById('joy-ready'), 'boolean'),
            enable_joy_drive_mode: getControllerValue(document.getElementById('joy-drive-mode'), 'boolean'),
            enable_collect_data: getControllerValue(document.getElementById('joy-collect-data'), 'boolean'),
            enable_horn: getControllerValue(document.getElementById('joy-horn'), 'boolean'),
            direct_high_cmd: getControllerValue(document.getElementById('joy-direct-cmd'), 'float'),
            offset_angle_steering: getControllerValue(document.getElementById('joy-offset-angle'), 'float'),
            tele_type: getControllerValue(document.getElementById('joy-tele-type'), 'string'),
            joystick_vel_cmd: buildNestedObject('.input-group.twist-group', 'joystick_vel_cmd', '#controller-view .control-section:first-of-type') // Scope to Joystick section
        };
         log.debug("Joystick Payload:", JSON.stringify(payload));
        socket.emit('send_command', { robot_id: selectedRobot, command_type: 'joystick_control', payload });
        // Optional: showCommandFeedback('info', `Joystick command sent.`);
    }

    function sendTestServerCommand() {
        // Test server command to check if robot receives it
        if (!selectedRobot || robotStatus[selectedRobot] !== 'online') { 
            showCommandFeedback('warning', 'Test: Robot not selected or offline.'); 
            return; 
        }
        log.info(`Sending Test Server Command for robot ${selectedRobot}`);
        
        const payload = {
            operation_mode: 2, // Auto mode
            drive_tele_mode: 0, // Tắt điều khiển từ xa
            server_cmd_state: 2, // 2 = gửi vị trí mới
            confirmation: 0,
            store_location: { x: 21.0285, y: 105.8542, z: 0.0 }, // Test location (Hanoi)
            customer_location: { x: 21.0295, y: 105.8552, z: 0.0 }, // Test customer location
            open_lid_cmd: 0, // Không mở nắp
            emb_map: "OCP", // Test map như trong script ROS
            tele_cmd_vel: {
                linear: { x: 0.0, y: 0.0, z: 0.0 },
                angular: { x: 0.0, y: 0.0, z: 0.0 }
            }
        };
        
        log.debug("Test Server Payload:", JSON.stringify(payload));
        socket.emit('send_command', { robot_id: selectedRobot, command_type: 'server_cmd', payload });
        showCommandFeedback('info', 'Test server command sent. Check robot logs for reception.');
    }

    // --- Quick Commands Functions ---
    function sendQuickNavCommand() {
        // Gửi lệnh điều hướng nhanh tới vị trí được nhập
        if (!selectedRobot || robotStatus[selectedRobot] !== 'online') {
            showCommandFeedback('warning', 'Quick Nav: Robot not selected or offline.');
            return;
        }
        
        const lat = parseFloat(dom.quickLatInput?.value);
        const lon = parseFloat(dom.quickLonInput?.value);
        
        if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            showCommandFeedback('warning', 'Quick Nav: Invalid coordinates. Please enter valid latitude (-90 to 90) and longitude (-180 to 180).');
            return;
        }
        
        log.info(`Sending Quick Nav Command for robot ${selectedRobot} to (${lat}, ${lon})`);
        
        const payload = {
            operation_mode: 2, // Auto mode
            drive_tele_mode: 0, // Tắt điều khiển từ xa
            server_cmd_state: 2, // 2 = gửi vị trí mới
            confirmation: 0,
            store_location: { x: lat, y: lon, z: 0.0 }, // Điểm cần tới
            customer_location: { x: lat, y: lon, z: 0.0 }, // Dùng cùng vị trí làm customer
            open_lid_cmd: 0, // Không mở nắp
            emb_map: "OCP", // Map mặc định
            tele_cmd_vel: {
                linear: { x: 0.0, y: 0.0, z: 0.0 },
                angular: { x: 0.0, y: 0.0, z: 0.0 }
            }
        };
        
        log.debug("Quick Nav Payload:", JSON.stringify(payload));
        socket.emit('send_command', { robot_id: selectedRobot, command_type: 'server_cmd', payload });
        showCommandFeedback('success', `Quick navigation command sent to ${selectedRobot} for coordinates (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
    }

    function sendEmergencyStop() {
        // Gửi lệnh dừng khẩn cấp - dừng robot ngay lập tức
        if (!selectedRobot || robotStatus[selectedRobot] !== 'online') {
            showCommandFeedback('warning', 'Emergency Stop: Robot not selected or offline.');
            return;
        }
        
        log.info(`Sending Emergency Stop Command for robot ${selectedRobot}`);
        
        // Gửi lệnh dừng qua joystick control với e_stop = true
        const joystickPayload = {
            e_stop: true, // Dừng khẩn cấp
            joy_ready: false,
            enable_joy_drive_mode: false,
            enable_collect_data: false,
            enable_horn: false,
            direct_high_cmd: 0.0,
            offset_angle_steering: 0.0,
            tele_type: "emergency_stop",
            joystick_vel_cmd: {
                linear: { x: 0.0, y: 0.0, z: 0.0 },
                angular: { x: 0.0, y: 0.0, z: 0.0 }
            }
        };
        
        // Gửi lệnh server_cmd với trạng thái hủy
        const serverPayload = {
            operation_mode: 0, // Manual mode
            drive_tele_mode: 1, // Bật điều khiển từ xa để dừng
            server_cmd_state: 5, // 5 = hủy nhiệm vụ
            confirmation: 0,
            store_location: { x: 0.0, y: 0.0, z: 0.0 },
            customer_location: { x: 0.0, y: 0.0, z: 0.0 },
            open_lid_cmd: 0,
            emb_map: "OCP",
            tele_cmd_vel: {
                linear: { x: 0.0, y: 0.0, z: 0.0 },
                angular: { x: 0.0, y: 0.0, z: 0.0 }
            }
        };
        
        log.debug("Emergency Stop Joystick Payload:", JSON.stringify(joystickPayload));
        log.debug("Emergency Stop Server Payload:", JSON.stringify(serverPayload));
        
        // Gửi cả hai lệnh để đảm bảo robot dừng
        socket.emit('send_command', { robot_id: selectedRobot, command_type: 'joystick_control', payload: joystickPayload });
        socket.emit('send_command', { robot_id: selectedRobot, command_type: 'server_cmd', payload: serverPayload });
        
        showCommandFeedback('error', `🚨 EMERGENCY STOP sent to ${selectedRobot}! Robot should stop immediately.`);
        
        // Dừng sequence nếu đang chạy
        if (sequenceActive) {
            log.warn("Emergency stop triggered during active sequence. Stopping sequence.");
            stopSequence('error');
        }
    }

    function sendCancelMission() {
        // Gửi lệnh hủy nhiệm vụ hiện tại
        if (!selectedRobot || robotStatus[selectedRobot] !== 'online') {
            showCommandFeedback('warning', 'Cancel Mission: Robot not selected or offline.');
            return;
        }
        
        log.info(`Sending Cancel Mission Command for robot ${selectedRobot}`);
        
        const payload = {
            operation_mode: 0, // Manual mode
            drive_tele_mode: 0, // Tắt điều khiển từ xa
            server_cmd_state: 5, // 5 = hủy nhiệm vụ
            confirmation: 0,
            store_location: { x: 0.0, y: 0.0, z: 0.0 },
            customer_location: { x: 0.0, y: 0.0, z: 0.0 },
            open_lid_cmd: 0,
            emb_map: "OCP",
            tele_cmd_vel: {
                linear: { x: 0.0, y: 0.0, z: 0.0 },
                angular: { x: 0.0, y: 0.0, z: 0.0 }
            }
        };
        
        log.debug("Cancel Mission Payload:", JSON.stringify(payload));
        socket.emit('send_command', { robot_id: selectedRobot, command_type: 'server_cmd', payload });
        
        showCommandFeedback('warning', `Mission cancelled for ${selectedRobot}. Robot should stop current task.`);
        
        // Dừng sequence nếu đang chạy
        if (sequenceActive) {
            log.warn("Cancel mission triggered during active sequence. Stopping sequence.");
            stopSequence('error');
        }
    }

    // --- Socket.IO Event Listeners ---
    socket.on('connect', () => {
        log.info('Socket.IO Connected! SID:', socket.id);
        updateConnectionStatus(true);
        setStatus("Connected. Requesting initial state...", true);
        if (statusCheckInterval) clearInterval(statusCheckInterval); statusCheckInterval = null;
        clearCommandFeedback();
        // Server should automatically send initial_state on connection
    });

    socket.on('disconnect', (reason) => {
        log.warn('Socket.IO Disconnected:', reason);
        updateConnectionStatus(false, `Disconnected: ${reason}`);
        setStatus("Disconnected. Attempting to reconnect...", true);
        if(dom.robotSelector) dom.robotSelector.disabled = true;
        disableController("Disconnected from server.", true);
        if (statusCheckInterval) clearInterval(statusCheckInterval); statusCheckInterval = null;
        // Mark robots as offline visually
        Object.keys(robotStatus).forEach(rId => robotStatus[rId] = 'offline');
        updateRobotStatusUI();
        if (sequenceActive) { log.warn("Socket disconnected during active sequence. Stopping."); stopSequence('error'); }
    });

    socket.on('connect_error', (err) => {
        log.error('Socket.IO Connection Error:', err);
        updateConnectionStatus(false, `Connection Error`);
        setStatus(`Connection Error: ${err.message}. Retrying...`, true);
        if(dom.robotSelector) dom.robotSelector.disabled = true;
        disableController("Connection error.", true);
        if (statusCheckInterval) clearInterval(statusCheckInterval); statusCheckInterval = null;
        Object.keys(robotStatus).forEach(rId => robotStatus[rId] = 'offline'); updateRobotStatusUI();
        if (sequenceActive) { log.warn("Socket connection error during active sequence. Stopping."); stopSequence('error'); }
    });

    socket.on('initial_state', (state) => {
        log.info('Received initial state from server.');
        log.debug('Initial state data:', state); // Log the whole state
        try {
            latestData = state.all_data || {};
            knownRobots = state.known_robots || [];
            expectedSubTopics = state.robot_sub_topics || [];
            robotStatus = {}; // Reset status

            // Initialize status based on received data
            knownRobots.forEach(rId => {
                 const lastSeen = latestData[rId]?.last_seen || 0;
                 if (lastSeen > 0 && (Date.now() - lastSeen) < OFFLINE_THRESHOLD) robotStatus[rId] = 'online';
                 else if (lastSeen > 0) robotStatus[rId] = 'offline';
                 else robotStatus[rId] = 'waiting';
                 log.debug(`Initial status for ${rId}: ${robotStatus[rId]} (last seen: ${lastSeen})`);
            });

            populateRobotSelector(); // Populate dropdown

            // Start status checking ONLY after getting initial state
            if (statusCheckInterval) clearInterval(statusCheckInterval);
            statusCheckInterval = setInterval(checkAllRobotStatuses, STATUS_CHECK_INTERVAL);
            log.info(`Robot status check interval (${STATUS_CHECK_INTERVAL / 1000}s) started.`);
            checkAllRobotStatuses(); // Initial check

            // Restore UI based on selection
            if (selectedRobot && knownRobots.includes(selectedRobot)) {
                log.info(`Restoring state for selected robot: ${selectedRobot}`);
                populateTopicList(selectedRobot);
                if (selectedSubTopic) {
                    log.debug(`Restoring selected topic: ${selectedSubTopic}`);
                    configureLayoutForTopic(selectedSubTopic);
                    renderData();
                } else {
                     log.debug(`No subtopic selected for ${selectedRobot}. Setting status.`);
                    setStatus(`Select a topic for ${selectedRobot}.`, true);
                }
                // Update maps/controller state
                updateOsmMapPositionFromStatus();
                if(osmMap) updateGpsPathFromState(osmMap, 'dashboard');
                initControllerMap(); // Make sure controller map is ready if needed
                centerControllerMapOnRobot(); updateControllerMapRobotMarker(); updateControllerMapRoute();
                updateStoredMarkerPositions();
                checkAllRobotStatuses(); // Update controller enabled state
            } else {
                 log.info("No valid robot previously selected or selection is now invalid. Deselecting.");
                selectRobot(null); // Deselect if invalid
            }
            // Set initial status message after processing
             if (!selectedRobot) {
                setStatus("Ready. Select a robot.", true);
             } else if (!selectedSubTopic) {
                 // Status already set above
             } else {
                 // If a topic is selected, renderData will set the status/header correctly
                 // renderData(); // Already called above if topic was selected
             }
            log.info("Initial state processed successfully.");

        } catch (e) {
            log.error("Error processing initial state:", e);
            setStatus("Error processing initial state. Please reload.", true);
            disableController("Initialization error.");
        }
    });

    socket.on('mqtt_data', (data) => {
        // Process incoming MQTT data forwarded by the server
        // --- ADDED: Log all incoming MQTT data via socket ---
        // log.debug("<<< Received 'mqtt_data' via SocketIO:", data);

        if (!data?.robot_id || !data?.sub_topic || data.data === undefined || data.robot_last_seen === undefined) {
             log.warn("Incomplete MQTT data via SocketIO:", data);
             return;
        }
        // data.data is the object { payload: ..., timestamp: ms }
        const { robot_id, sub_topic, data: topicEntry, robot_last_seen } = data;

         // --- ADDED: Specific log for bulldog/routed_map arrival ---
         if (robot_id === 'bulldog01_5f899b' && sub_topic === 'routed_map') {
             log.debug(`>>> Received bulldog/routed_map data via socket. Payload type: ${typeof topicEntry?.payload}, Timestamp: ${topicEntry?.timestamp}`);
             if (typeof topicEntry?.payload === 'object' && topicEntry.payload !== null && topicEntry.payload.data) {
                 log.debug(`    Payload keys: ${Object.keys(topicEntry.payload)}, Data field type: ${typeof topicEntry.payload.data}, Is Array: ${Array.isArray(topicEntry.payload.data)}, Data length: ${Array.isArray(topicEntry.payload.data) ? topicEntry.payload.data.length : 'N/A'}`);
             } else if (typeof topicEntry?.payload === 'string' && topicEntry.payload.startsWith('Error:')) {
                  log.warn(`    Received payload is an error string: ${topicEntry.payload}`);
             }
         }
         // --- End specific log ---


        if (!knownRobots.includes(robot_id)) return; // Ignore unknown robots

        // Ensure data structure exists
        if (!latestData[robot_id]) latestData[robot_id] = { last_seen: 0, topics: {} };
        if (!latestData[robot_id].topics) latestData[robot_id].topics = {};

        const oldLastSeen = latestData[robot_id].last_seen || 0;
        // Store the { payload: ..., timestamp: ... } object
        latestData[robot_id].topics[sub_topic] = topicEntry;
        latestData[robot_id].last_seen = robot_last_seen;

        // Update status if needed (reduce frequency of checks unless status changes)
        const previousStatus = robotStatus[robot_id];
        const now = Date.now();
        let currentStatus = 'offline';
        if (robot_last_seen > 0 && (now - robot_last_seen) < OFFLINE_THRESHOLD) currentStatus = 'online';
        else if (robot_last_seen > 0) currentStatus = 'offline';
        else currentStatus = 'waiting';

        if (previousStatus !== currentStatus) {
            log.debug(`Status change detected for ${robot_id} on message receipt: ${previousStatus} -> ${currentStatus}. Triggering checkAllRobotStatuses.`);
            checkAllRobotStatuses(); // Re-evaluates status for all robots and updates UI/controller
        } else if (robot_id === selectedRobot && currentStatus === 'online' && dom.controllerContent?.classList.contains('controller-disabled')) {
             // If the selected robot was previously offline/waiting but is now online, re-enable controller immediately
              log.debug(`Selected robot ${robot_id} is now online. Triggering checkAllRobotStatuses to potentially re-enable controller.`);
              checkAllRobotStatuses();
        }


        // Update UI ONLY if data is for the currently selected robot AND topic/view
        if (robot_id === selectedRobot) {
            // Update main data display if topic matches and dashboard view is active
            if (sub_topic === selectedSubTopic && currentView === 'dashboard-view') {
                 log.debug(`Rendering data for selected topic ${sub_topic}`);
                renderData();
            }

            // Handle specific topics for background map updates or sequence confirmation
            if (sub_topic === 'robot_status') {
                // log.debug("Updating map markers due to robot_status update."); // Noisy
                updateOsmMapPositionFromStatus(); // Update dashboard map marker
                updateControllerMapRobotMarker(); // Update controller map marker

                const payload = topicEntry?.payload; // Access inner payload
                if (sequenceActive && payload?.confirmation === ARRIVED_CONFIRMATION_CODE) {
                    log.info(`Arrival confirmation code (${ARRIVED_CONFIRMATION_CODE}) received via robot_status.`);
                    handleArrivalConfirmation();
                }
            } else if (sub_topic === 'gloal_path_gps') {
                const pathPayload = topicEntry?.payload; // Access inner payload
                 // Always update the controller map path if the map exists
                if (controllerMapInstance) {
                    // log.debug("Updating controller map GPS path."); // Noisy
                    drawGpsPath(pathPayload, controllerMapInstance, 'controller');
                }
                 // Update the dashboard map path ONLY if it's the selected topic and view
                if (selectedSubTopic === 'gloal_path_gps' && currentView === 'dashboard-view') {
                    // log.debug("Updating dashboard map GPS path (selected topic)."); // Noisy
                    // drawGpsPath is called within renderData in this case
                }
            } else if (sub_topic === 'routed_map') {
                 // renderData() is already called above if this is the selected topic/view
                 // Only need to update the OSM context map marker position in the background
                 // log.debug("Updating OSM marker position due to routed_map update."); // Noisy
                 updateOsmMapPositionFromStatus();
            }
        }
    });


    socket.on('command_feedback', (data) => {
        // Display feedback messages from the server after sending commands
        log.debug("Command feedback received from server:", data);
        if (data?.message) {
            showCommandFeedback(data.status || 'info', data.message);
        }
    });

    // --- Start Application ---
    window.addEventListener('load', initializeDashboard);

})(); // End IIFE