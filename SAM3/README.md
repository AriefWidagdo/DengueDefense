# SAM3 counter

`modal_counter.py` defines the GPU service used by the capture backend. It loads the SAM3 checkpoint from the read-only Modal volume `sam3-checkpoint` and saves counter outputs to a separate `sam3-outputs` volume. The checkpoint, credentials, input images, and saved outputs are not included here.

A deployment needs authorized access to SAM3 and its checkpoint, a Modal account, both volumes, and a deployed counter service. Follow the upstream model's access and license requirements. GPU startup and inference can incur charges. Do not expose Modal credentials to the browser.

`count_image.py` is an authenticated Modal client for a single image. The capture backend normally calls the deployed `ObjectCounter.count` method asynchronously and retains its call ID.

The result is a set of candidate detections, not a validated mosquito count or a species identification. Human review is required.
