# AI Horde — free text-to-image, no key (public anonymous key), PowerShell version
$headers = @{ apikey = "0000000000" }
$body = @{
    prompt = "a lighthouse on a rocky shore at golden hour, digital painting"
    params = @{ width = 512; height = 512; steps = 15; sampler_name = "k_euler"; cfg_scale = 7; n = 1 }
    models = @("stable_diffusion")
    slow_workers = $true
} | ConvertTo-Json -Depth 5

$job = Invoke-RestMethod -Method Post -Uri "https://stablehorde.net/api/v2/generate/async" -Headers $headers -ContentType "application/json" -Body $body
Write-Host "job id: $($job.id)"

do {
    Start-Sleep -Seconds 9
    $check = Invoke-RestMethod -Uri "https://stablehorde.net/api/v2/generate/check/$($job.id)"
    Write-Host "done=$($check.done) queue=$($check.queue_position)"
} until ($check.done)

$status = Invoke-RestMethod -Uri "https://stablehorde.net/api/v2/generate/status/$($job.id)"
$url = $status.generations[0].img
Invoke-WebRequest -Uri $url -OutFile "$PSScriptRoot\horde-sample.webp"
Write-Host "saved: $PSScriptRoot\horde-sample.webp"