$ppt = New-Object -ComObject PowerPoint.Application
try {
  $pres = $ppt.Presentations.Open('D:\Jash\WDS\monthly-monitoring-testing-system\Monthly_Monitoring_Report_October_2026_v2.pptx', [Microsoft.Office.Core.MsoTriState]::msoFalse, [Microsoft.Office.Core.MsoTriState]::msoFalse, [Microsoft.Office.Core.MsoTriState]::msoFalse)
  $outPdf = 'D:\Jash\WDS\monthly-monitoring-testing-system\temp_inspect_v2.pdf'
  if (Test-Path $outPdf) { Remove-Item $outPdf -Force }
  $pres.SaveAs($outPdf, 32)
  $pres.Close()
} finally {
  $ppt.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
Write-Host "Exported to PDF and closed cleanly"
